<?php

declare(strict_types=1);

namespace LaraGrid\Livewire;

use Illuminate\Auth\Access\AuthorizationException;
use InvalidArgumentException;
use LaraGrid\Columns\SearchSelectColumn;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Grid;
use LaraGrid\Query\QueryPipeline;
use LaraGrid\Support\RowSerializer;
use Illuminate\Validation\ValidationException;
use Livewire\Attributes\Renderless;

use function Livewire\store;

/**
 * What: The host-component trait that exposes one or more named Grids to the client and serves
 *       their server-side data + edits over renderless RPCs: the readonly data channel (gridFetch,
 *       M3), the editing channel + clean-rows accessor (gridOps/gridRows, M4), and the picker
 *       options channel (gridOptions, M5). A row-action channel (the umbrella's gridAction) was
 *       never needed in v1 and is deliberately absent — design it fresh when a consumer appears
 *       (M7 Q2 resolution).
 *
 * Why:  Every grid RPC must run on the HOST component so it inherits the host's tenancy (re-bound
 *       in the host's own booted(), the established pattern — see Items\Index) and the host's
 *       policies. The grid never carries its own auth (plan §3.11 portability): it only declares
 *       an ->authorize() gate that this trait enforces, fail-closed (G12) — a server-side grid
 *       whose authorization denies (or is absent, caught at build time) never returns a row.
 *       Whitelisted sort/search/filter keys in the QueryPipeline close the RPC's injection surface.
 *
 * When: `use WithLaraGrid` on a Livewire host that renders <x-laragrid>; the client calls
 *       $wire.gridFetch('name', {...}) for every sort/search/filter/page change (the first page
 *       ships in config, so no fetch is needed for the initial paint).
 */
trait WithLaraGrid
{
    /**
     * Per-request cache of the resolved grid definitions, so grids() (which may run tenant-scoped
     * option lookups) is built once per Livewire request, not per RPC + per render.
     *
     * @var array<string, Grid>|null
     */
    private ?array $gridsCache = null;

    /**
     * The grids this host exposes, keyed by name.
     *
     * @return array<string, Grid>
     */
    abstract protected function grids(): array;

    /**
     * Resolve (and memoise) the host's grids for this request.
     *
     * @return array<string, Grid>
     */
    protected function resolvedGrids(): array
    {
        return $this->gridsCache ??= $this->grids();
    }

    /**
     * Resolve a single named grid definition, or throw if the host declares no such grid.
     *
     * Why: Used by the host's render() to hand a Grid to <x-laragrid :grid>, and internally by
     *      the RPCs. Throwing on an unknown name keeps a typo (or a client naming a phantom grid)
     *      a clear error rather than a silent empty grid.
     *
     * @throws InvalidArgumentException When no grid is registered under $name.
     */
    public function gridDefinition(string $name): Grid
    {
        $grids = $this->resolvedGrids();

        if (! isset($grids[$name])) {
            throw new InvalidArgumentException(
                class_basename(static::class)." has no grid named [{$name}]."
            );
        }

        return $grids[$name];
    }

    /**
     * Fetch one page of a server-side grid's rows (sort / global search / filters / pagination all
     * applied server-authoritatively). Renderless: the grid body lives inside wire:ignore and is
     * repainted entirely client-side from this payload, so no Livewire morph occurs (R3).
     *
     * @param  array{sort?: string|null, dir?: string|null, search?: string|null, filters?: array<string, mixed>, page?: int|string|null, perPage?: int|string|null}  $query
     * @return array{rows: list<array<string, mixed>>, total: int, page: int, perPage: int, lastPage: int, pageTotals: array<string, int|float>, grandTotals: array<string, int|float>}
     *
     * @throws AuthorizationException When the grid's ->authorize() gate denies.
     * @throws InvalidArgumentException When the grid is unknown or not server-side.
     */
    #[Renderless]
    public function gridFetch(string $grid, array $query): array
    {
        $definition = $this->gridDefinition($grid);

        $this->authorizeGrid($definition);

        if (! $definition->isServerSide()) {
            throw new InvalidArgumentException("Grid [{$grid}] is not server-side; gridFetch is unavailable.");
        }

        return app(QueryPipeline::class)->run($definition, $query)->toArray();
    }

    /**
     * Apply a batch of client edits to an editable grid's rows and return the authoritative result
     * (write-backs + per-cell errors + recomputed footer + new version). Renderless by DEFAULT so
     * the wire:ignore body is never morphed — the client repaints from the response (R3).
     *
     * Dynamic Renderless drop (G6): when any op in the batch touched a ->refreshesHost() column,
     * we drop the render skip *inside* the method. The #[Renderless] attribute's hook runs
     * BEFORE the action (Livewire's trigger('call') fires attribute hooks first) and has already
     * stored the 'skipRender' flag by the time this method executes — forceRender() alone cannot
     * undo it (it only short-circuits FUTURE skipRender() calls). So we set forceRender AND
     * unset the stored 'skipRender' flag, which is what HandleComponents::render() actually
     * gates on (verified against this Livewire build; the M4 assumption that the hook ran after
     * the action was wrong — caught by the M5 enrichment browser test asserting host chrome).
     * The host then re-renders its chrome (totals/tax panels living outside the grid) while the
     * body — inside wire:ignore — stays untouched.
     *
     * @param  array{baseVersion?: int, ops: list<array<string, mixed>>}  $payload
     * @return array{version: int, results: list<array<string, mixed>>, footer: array<string, int|float|string>}
     *
     * @throws AuthorizationException When the grid's ->authorize() gate denies.
     * @throws InvalidArgumentException When the grid is unknown or not editable.
     */
    #[Renderless]
    public function gridOps(string $grid, array $payload): array
    {
        $definition = $this->gridDefinition($grid);

        $this->authorizeGrid($definition);

        if (! $definition->isEditable()) {
            throw new InvalidArgumentException("Grid [{$grid}] is not editable; gridOps is unavailable.");
        }

        $property = $definition->getRowsProperty();
        if ($property === null) {
            // assertValid already enforces this; guard so a bypass can't reach the applier.
            throw new InvalidArgumentException("Grid [{$grid}] declares no rowsFrom(); cannot apply ops.");
        }

        $batch = OpBatch::fromPayload($payload);

        /** @var list<array<string, mixed>> $rows */
        $rows = (array) ($this->{$property} ?? []);

        $result = app(OpApplier::class)->apply($definition, $rows, $batch, $batch->baseVersion);

        // Write the authoritative rows back to the host property so save() + a possible re-render
        // read the applied state (cast values, recomputed formulas, row structure).
        $this->{$property} = $result->rows;

        // Drop Renderless when host chrome must refresh (G6) — see the method docblock: the
        // attribute hook already stored 'skipRender' BEFORE this method ran, so it must be
        // unset explicitly; forceRender() alone only guards against later skipRender() calls.
        if ($result->refreshHost) {
            $this->forceRender();
            store($this)->unset('skipRender');
        }

        return $result->toArray();
    }

    /**
     * Search a SearchSelectColumn's server options for a typed term (M5, umbrella §2.5.3).
     * Renderless: the popup renders the returned list entirely client-side.
     *
     * What: Authorizes the grid (fail-closed, G12), requires an editable grid + a server-mode
     *       SearchSelectColumn, then runs the column's tenant-scoped closure. Normalisation,
     *       alphabetical ordering and the ≤ limit(≤50) cap are enforced by the COLUMN
     *       (resolveOptions), not left to the closure.
     * Why:  Option search is a data-access surface: it must run on the host (tenancy re-bound in
     *       the host's booted()) behind the grid's authorize gate, and never return more than the
     *       declared cap. `$row` is the CLIENT's row snapshot (so options can depend on sibling
     *       cells, e.g. UoMs filtered by item) — closures must treat it as untrusted input.
     *
     * @param  array<string, mixed>  $row
     * @return array{options: list<array{value: string, label: string}>}
     *
     * @throws AuthorizationException When the grid's ->authorize() gate denies.
     * @throws InvalidArgumentException When the grid/column doesn't serve options.
     */
    #[Renderless]
    public function gridOptions(string $grid, string $column, string $term = '', array $row = []): array
    {
        $definition = $this->gridDefinition($grid);

        $this->authorizeGrid($definition);

        if (! $definition->isEditable()) {
            throw new InvalidArgumentException("Grid [{$grid}] is not editable; gridOptions is unavailable.");
        }

        $target = $definition->column($column);
        if (! $target instanceof SearchSelectColumn || ! $target->hasServerOptions()) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] column [{$column}] does not provide server-side options."
            );
        }

        return ['options' => $target->resolveOptions($term, $row)];
    }

    /**
     * Run a named call() action (P7) - row, bulk, or toolbar scope - fail-closed.
     *
     * What: Grid gate first, then the action's own ->authorize(), then (row scope) an
     *       authoritative row re-resolution + ->visible() re-check before the closure runs:
     *       the client only ever echoed a NAME and row KEYS. Row actions re-read the row from
     *       the query (server-side grids) or the bound property (editable grids) - never from
     *       client-supplied data. A ValidationException becomes {ok:false, message} for the
     *       operator; anything else bubbles.
     * Why:  A hidden button must also be an unusable button; a URL action must not be callable.
     * When: Client ActionRunner - button click, action menu, bulk bar.
     *
     * @param  list<string>  $rowKeys
     * @return array<string, mixed>
     *
     * @throws AuthorizationException|InvalidArgumentException
     */
    #[Renderless]
    public function gridAction(string $grid, string $action, array $rowKeys = []): array
    {
        $definition = $this->gridDefinition($grid);

        $this->authorizeGrid($definition);

        $found = $definition->findAction($action);
        if ($found === null) {
            throw new InvalidArgumentException("Grid [{$grid}] has no action named [{$action}].");
        }
        [$target, $scope] = $found;

        if (! $target->hasCall()) {
            throw new InvalidArgumentException("Grid [{$grid}] action [{$action}] is a url action; it cannot be called.");
        }

        $gate = $target->getAuthorization();
        if (is_string($gate)) {
            $this->authorize($gate);
        } elseif ($gate !== null) {
            $gate();
        }

        try {
            if ($scope === 'row') {
                $key = (string) ($rowKeys[0] ?? '');
                $row = $this->resolveActionRow($definition, $key);
                if ($row === null) {
                    return ['ok' => false, 'message' => 'That row no longer exists.'];
                }
                if (! $target->isVisibleFor($row)) {
                    throw new AuthorizationException("Action [{$action}] is not available for this row.");
                }
                ($target->getCall())($row);
            } elseif ($scope === 'bulk') {
                ($target->getCall())(array_values(array_map('strval', $rowKeys)));
            } else {
                ($target->getCall())();
            }
        } catch (ValidationException $e) {
            return ['ok' => false, 'message' => $e->getMessage()];
        }

        $response = ['ok' => true];

        // The action likely changed data: server-side grids refetch their current page;
        // editable grids receive the (possibly mutated) bound rows as a reseed payload.
        if ($definition->isServerSide()) {
            $response['refetch'] = true;
        } elseif ($definition->isEditable()) {
            $property = $definition->getRowsProperty();
            /** @var list<array<string, mixed>> $rows */
            $rows = $property !== null ? (array) ($this->{$property} ?? []) : [];
            $response['rows'] = app(RowSerializer::class)->serializeMany($definition, $rows);
            $footer = [];
            foreach ($definition->getFooter() as $aggregate) {
                $footer[$aggregate->column] = $aggregate->compute($response['rows']);
            }
            $response['footer'] = $footer;
        }

        return $response;
    }

    /**
     * Re-resolve a row action target authoritatively: by primary key through the grid query
     * (server-side), or by `_k` in the bound property (editable). Null when gone.
     *
     * @return array<string, mixed>|null
     */
    protected function resolveActionRow(Grid $definition, string $key): ?array
    {
        if ($key === '') {
            return null;
        }

        if ($definition->isServerSide()) {
            $model = $definition->resolveQuery()->where($definition->getRowKey(), $key)->first();

            return $model?->toArray();
        }

        $property = $definition->getRowsProperty();
        /** @var list<array<string, mixed>> $rows */
        $rows = $property !== null ? (array) ($this->{$property} ?? []) : [];
        foreach ($rows as $row) {
            if (($row['_k'] ?? null) === $key) {
                return $row;
            }
        }

        return null;
    }

    /**
     * The clean rows for an editable grid's host save() — blank trailing rows stripped and the
     * client-only `_k` removed. The host calls this instead of reading its raw property so the
     * grid's client bookkeeping never leaks into the persisted data (umbrella §3.3).
     *
     * @return list<array<string, mixed>>
     *
     * @throws InvalidArgumentException When the grid is unknown or not editable.
     */
    public function gridRows(string $grid): array
    {
        $definition = $this->gridDefinition($grid);

        if (! $definition->isEditable()) {
            throw new InvalidArgumentException("Grid [{$grid}] is not editable; gridRows is unavailable.");
        }

        $property = $definition->getRowsProperty();
        /** @var list<array<string, mixed>> $rows */
        $rows = $property !== null ? (array) ($this->{$property} ?? []) : [];

        return app(RowSerializer::class)->cleanEditableRows($definition, $rows);
    }

    /**
     * The seed rows for a fresh editable grid — ->defaultRows() rows built by makeNewRow()
     * (all columns null overlaid with the ->newRowUsing() factory), each carrying a generated
     * stable `_k`.
     *
     * Why: Replaces the hand-rolled "empty line factory + mount seeding" every host previously
     *      wrote; the SAME shape the op protocol's INSERT produces, so a seeded row and a grown
     *      row are indistinguishable. Call from mount(): $this->lines = $this->gridMountRows('lines').
     *
     * @return list<array<string, mixed>>
     *
     * @throws InvalidArgumentException When the grid is unknown or not editable.
     */
    protected function gridMountRows(string $grid): array
    {
        $definition = $this->gridDefinition($grid);

        if (! $definition->isEditable()) {
            throw new InvalidArgumentException("Grid [{$grid}] is not editable; gridMountRows is unavailable.");
        }

        $rows = [];
        for ($i = 0; $i < max(1, $definition->getDefaultRows()); $i++) {
            $rows[] = $definition->makeNewRow('l'.bin2hex(random_bytes(4)));
        }

        return $rows;
    }

    /**
     * Resume a grid after the host panel it opened (a column's ->opensPanel()) has closed —
     * dispatches `lgrid:panel-done`, which re-focuses the grid and runs the deferred advance.
     * Call on every panel exit path (OK, cancel, Esc, click-away).
     */
    protected function gridPanelDone(string $grid): void
    {
        $this->gridDefinition($grid); // throw early on a typo

        $this->dispatch('lgrid:panel-done', grid: $grid);
    }

    /**
     * Push a grid's CURRENT rows to the client wholesale (`lgrid:reseed`) — any mode.
     *
     * What: Serializes the given rows (or, when omitted, the rowsFrom()-bound property) through
     *       the RowSerializer (the exact `config.rows` shape — `_k` and `_labels` intact,
     *       computeds baked), recomputes the footer aggregates as the flat {column: total} map,
     *       and dispatches the `lgrid:reseed` browser event GridCore subscribes to in every
     *       mode. An editable client also drops ALL its editing bookkeeping (op queue, op log,
     *       dirty/pending marks, cell errors) — see StateStore.reseed().
     * Why:  The grid body lives inside `wire:ignore` and receives rows only in the initial
     *       config, so any host-side change is otherwise invisible. For an EDITABLE grid the
     *       stakes are drift: a save() exit path that swaps the bound property (gridRows()
     *       output on failure, fresh lines on success) leaves the client referencing row keys
     *       the server no longer has. For a DISPLAY grid this is simply the data-refresh
     *       channel: pass the new rows explicitly and the snapshot repaints without a remount.
     * When: Editable hosts MUST call this after every out-of-band rows mutation (each save()
     *       exit path, success and failure alike); display hosts whenever their data changes —
     *       reseedGrid('name', $freshRows).
     *
     * @param  list<array<string, mixed>>|null  $rows  Explicit rows; null reads the rowsFrom() property.
     *
     * @throws InvalidArgumentException When the grid is unknown, or a server-side ->query()
     *                                  grid is reseeded (its data channel is gridFetch).
     */
    protected function reseedGrid(string $grid, ?array $rows = null): void
    {
        $definition = $this->gridDefinition($grid);

        if ($definition->isServerSide()) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] is server-side; its rows refresh through gridFetch, not reseedGrid()."
            );
        }

        if ($rows === null) {
            $property = $definition->getRowsProperty();
            /** @var list<array<string, mixed>> $rows */
            $rows = $property !== null ? (array) ($this->{$property} ?? []) : [];
        }

        $serialized = app(RowSerializer::class)->serializeMany($definition, $rows);

        $footer = [];
        foreach ($definition->getFooter() as $aggregate) {
            $footer[$aggregate->column] = $aggregate->compute($serialized);
        }

        $this->dispatch('lgrid:reseed', grid: $grid, rows: $serialized, footer: $footer);
    }

    /**
     * Enforce a grid's authorization gate — fail-closed.
     *
     * What: Runs the grid's declared ->authorize(): a Closure (typically fn () => $this->authorize(...))
     *       is invoked; an ability string is resolved against the host's authorize(). A missing gate
     *       on a server-side grid is already rejected at build time (Grid::assertValid), but we
     *       double-check here so no data path can bypass it.
     * Why:  The RPC is a data-access surface; a grid must never return rows the host user can't see.
     *
     * @throws AuthorizationException
     */
    protected function authorizeGrid(Grid $definition): void
    {
        $gate = $definition->getAuthorization();

        if ($gate === null) {
            // Server-side grids are caught at build time; an in-memory grid reaching an RPC is a bug.
            throw new AuthorizationException("Grid [{$definition->name}] declares no authorization.");
        }

        if (is_string($gate)) {
            $this->authorize($gate);

            return;
        }

        $gate();
    }
}
