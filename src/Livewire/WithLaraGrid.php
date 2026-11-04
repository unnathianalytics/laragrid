<?php

declare(strict_types=1);

namespace LaraGrid\Livewire;

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Illuminate\Validation\Rules\In;
use Illuminate\Validation\Rules\NotIn;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;
use LaraGrid\Casting\CastRegistry;
use LaraGrid\Columns\SearchSelectColumn;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Editing\RowsContext;
use LaraGrid\Export\ExportBuilder;
use LaraGrid\Export\ExporterRegistry;
use LaraGrid\Grid;
use LaraGrid\Query\QueryPipeline;
use LaraGrid\Query\QueryStore;
use LaraGrid\Support\MountedGrids;
use LaraGrid\Support\RowSerializer;
use LaraGrid\Validation\RuleCompiler;
use LaraGrid\Views\ViewState;
use LaraGrid\Views\ViewStore;
use Livewire\Attributes\Locked;
use Livewire\Attributes\Renderless;
use Symfony\Component\HttpFoundation\StreamedResponse;

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
    /** Server-owned revision per editable grid; locked against client mutation. */
    #[Locked]
    public array $laraGridVersions = [];

    /**
     * Change tracking (->trackChanges(), F6): the baseline row keys per grid, in baseline order.
     * A grid without an entry has no baseline yet (taken at its first op or reseed).
     *
     * @var array<string, list<string>>
     */
    #[Locked]
    public array $laraGridBaseline = [];

    /**
     * Change tracking: removed baseline rows per grid, key => the row with its original values.
     *
     * @var array<string, array<string, array<string, mixed>>>
     */
    #[Locked]
    public array $laraGridRemoved = [];

    /**
     * The grids this host's LAST render mounted (grid name => true). A later render re-sends
     * those as shell configs (perf plan P1). Locked: a client that could add a name here would
     * receive a shell for a grid it never mounted.
     *
     * @var array<string, true>
     */
    #[Locked]
    public array $laraGridMounted = [];

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
     * Livewire trait hook, before the host view renders: open a MountedGrids pass seeded with
     * the grids the browser already holds, so each <x-laragrid> can ship a shell instead of
     * re-serializing rows nobody reads.
     *
     * Public because Livewire invokes trait hooks as public methods, which also makes it
     * callable as a client action. A stray call only opens a pass that no render reads.
     */
    public function renderingWithLaraGrid(): void
    {
        app(MountedGrids::class)->enter($this->laraGridMounted);
    }

    /**
     * Livewire trait hook, after the host view rendered: record exactly the grids this pass
     * mounted. A grid that left the view (an @if turned false) drops out, so its return ships
     * the full payload. A stray client call finds no open pass and changes nothing.
     */
    public function renderedWithLaraGrid(): void
    {
        $registry = app(MountedGrids::class);
        if ($registry->active()) {
            $this->laraGridMounted = $registry->leave();
        }
    }

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

        $definition = $grids[$name];
        if ($definition->isEditable()) {
            $definition->protocolVersion((int) ($this->laraGridVersions[$name] ?? 0));
        }

        return $definition;
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

        $page = app(QueryPipeline::class)->run($definition, $query)->toArray();

        // The single funnel: every sort, search, filter and per-page change the operator makes
        // arrives here, so persisting AFTER a successful run keeps the stored state to queries
        // that actually resolved (a throwing query never becomes the state you come back to).
        $this->persistGridQuery($definition, $query);

        return $page;
    }

    /**
     * Store the operator's current query for a grid that declares ->persistQuery().
     *
     * What: Sanitizes the client payload through the shared whitelist (ViewState::sanitizeQuery
     *       — same gate saved views use, including the per-filter accepts() check) and writes it
     *       to the bound QueryStore. The page number is deliberately absent from that shape: a
     *       return to the grid lands on page 1 of the remembered narrowing, never on page 7 of a
     *       list the operator has forgotten they filtered.
     * Why:  A state equal to the grid's declared defaults is FORGOTTEN rather than written, so an
     *       operator who never filters leaves no session entry at all, and clearing every control
     *       genuinely resets rather than persisting an "empty" state forever.
     * When: After each successful gridFetch.
     *
     * @param  array<string, mixed>  $query  The raw client payload.
     */
    protected function persistGridQuery(Grid $definition, array $query): void
    {
        $persist = $definition->getPersistQuery();

        if ($persist === null) {
            return;
        }

        // Merged over the declared defaults first: a PARTIAL payload (a caller sending only
        // `filters`) must mean "defaults, plus this filter" — not "and no sort, and no page
        // size", which would both persist a state the operator never chose and defeat the
        // default-equal check below.
        $state = app(ViewState::class)->sanitizeQuery(
            $definition,
            array_merge($definition->defaultQuery(), $query),
            checkOptions: false,
        );
        $store = app(QueryStore::class);

        // Filter values are offered to Filter::accepts() only when they are NEW or CHANGED versus
        // the stored state: a value already stored passed that check when it was written, so
        // paging or sorting under an active filter no longer re-runs its options lookup (often
        // a DB query) on every fetch. A stale value is still never persisted fresh, and one that
        // stops resolving later (tenant switch, deleted record) is dropped on the read path
        // (ConfigSerializer::initialQuery), which always checks.
        $stored = $store->get($persist['key']);
        $storedFilters = is_array($stored['filters'] ?? null) ? $stored['filters'] : [];
        $filtersByKey = [];
        foreach ($definition->getFilters() as $filter) {
            $filtersByKey[$filter->key] = $filter;
        }
        foreach ($state['filters'] as $key => $value) {
            $unchanged = array_key_exists($key, $storedFilters) && (string) $storedFilters[$key] === $value;
            if (! $unchanged && ! $filtersByKey[$key]->accepts($value)) {
                unset($state['filters'][$key]);
            }
        }

        if ($state == $definition->defaultQuery()) {
            $store->forget($persist['key']);

            return;
        }

        $store->put($persist['key'], $state);
    }

    /**
     * Drop a grid's persisted query, putting the operator back on its declared defaults.
     *
     * Why: Hosts own the events the package cannot see — a tenant switch, a "reset filters"
     *      control, a workflow that must start from a clean register. A grid that declares no
     *      ->persistQuery() is a silent no-op, so calling this defensively is always safe.
     *
     * @throws InvalidArgumentException When the host declares no grid under $grid.
     */
    public function forgetGridQuery(string $grid): void
    {
        $persist = $this->gridDefinition($grid)->getPersistQuery();

        if ($persist !== null) {
            app(QueryStore::class)->forget($persist['key']);
        }
    }

    /**
     * Download the grid's CURRENT view as a file — the whole filtered set in one of the
     * formats the grid's ->exportable() enables.
     *
     * What: Authorizes (fail-closed, the same gate as gridFetch), verifies the grid declares
     *       exports AND enables the requested format (the client only ever echoes a format
     *       NAME — a format the definition doesn't offer is refused even if registered), then
     *       streams the file through the named Exporter. The query payload carries the
     *       client's {sort, dir, search, filters} and runs through the SAME whitelisted
     *       narrowing pipeline as gridFetch. An in-memory grid's trusted exportRows resolver
     *       receives only normalized declared state and independently rebuilds server rows;
     *       Blade/Livewire display rows are never accepted as a download source.
     * Why:  Running on the host component keeps tenancy + policies exactly as every other
     *       grid RPC; Livewire turns the StreamedResponse into a browser download.
     *
     * @param  array{sort?: string|null, dir?: string|null, search?: string|null, filters?: array<string, mixed>}  $query
     *
     * @throws AuthorizationException When the grid's ->authorize() gate denies.
     * @throws InvalidArgumentException When the grid is unknown, not exportable, or the format not enabled.
     */
    #[Renderless]
    public function gridExport(string $grid, string $format, array $query = []): StreamedResponse
    {
        $definition = $this->gridDefinition($grid);

        $this->authorizeGrid($definition);

        $export = $definition->hasServerExportSource() ? $definition->getExport() : null;
        if ($export === null) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] is not exportable; declare ->exportable() with query() or exportRows()."
            );
        }

        if (! in_array($format, $export['formats'], true)) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] does not offer the [{$format}] export format; enabled: ".implode(', ', $export['formats']).'.'
            );
        }

        $exporter = app(ExporterRegistry::class)->resolve($format);
        $data = app(ExportBuilder::class)->build($definition, $query);

        $filename = Str::slug($export['fileName'] ?? $definition->name)
            .'-'.now()->format('Ymd-His').'.'.$exporter->extension();

        return response()->streamDownload(
            fn () => $exporter->write($data),
            $filename,
            ['Content-Type' => $exporter->mimeType()],
        );
    }

    /**
     * List the calling operator's saved views for a grid (the toolbar Views menu).
     *
     * What: Authorizes (fail-closed, the same gate as every grid RPC), requires the grid to
     *       declare ->savedViews(), and returns the operator-scoped views from the bound
     *       ViewStore. The scope is minted server-side from the authenticated user — the
     *       client can neither choose nor widen it.
     *
     * @return array{views: list<array{id: string, name: string, state: array<string, mixed>}>}
     *
     * @throws AuthorizationException When the gate denies or no user is authenticated.
     * @throws InvalidArgumentException When the grid is unknown or declares no savedViews().
     */
    #[Renderless]
    public function gridViews(string $grid): array
    {
        $definition = $this->viewableGrid($grid);

        return ['views' => app(ViewStore::class)->list($this->viewScope(), $definition->getSavedViews()['key'])];
    }

    /**
     * Save (or overwrite, by name) one view of the grid's current state.
     *
     * What: The state payload is untrusted client input — ViewState::sanitize reduces it to
     *       the whitelisted shape, validating every column/filter reference against the grid's
     *       declaration (G12). Saving an existing name updates that view (the operator mental
     *       model); the per-grid cap (config laragrid.views.max_per_grid) bounds runaway
     *       creation. Returns the saved view plus the refreshed list.
     *
     * @param  array<string, mixed>  $state
     * @return array{view: array{id: string, name: string, state: array<string, mixed>}, views: list<array{id: string, name: string, state: array<string, mixed>}>}
     *
     * @throws AuthorizationException When the gate denies or no user is authenticated.
     * @throws ValidationException When the name is blank/too long or the view cap is reached.
     * @throws InvalidArgumentException When the grid is unknown or declares no savedViews().
     */
    #[Renderless]
    public function gridViewSave(string $grid, string $name, array $state): array
    {
        $definition = $this->viewableGrid($grid);

        $name = trim($name);
        if ($name === '' || mb_strlen($name) > 60) {
            throw ValidationException::withMessages(['name' => 'A view name must be 1-60 characters.']);
        }

        $store = app(ViewStore::class);
        $scope = $this->viewScope();
        $key = $definition->getSavedViews()['key'];

        $existing = $store->list($scope, $key);
        $cap = max(1, (int) config('laragrid.views.max_per_grid', 50));
        $replaces = array_filter($existing, fn (array $view): bool => $view['name'] === $name) !== [];
        if (! $replaces && count($existing) >= $cap) {
            throw ValidationException::withMessages(['name' => "This grid already holds {$cap} saved views."]);
        }

        $view = $store->save($scope, $key, $name, app(ViewState::class)->sanitize($definition, $state));

        // An overwrite keeps the list's membership and order, so the pre-save list is updated in
        // place (no second read). A new name needs the store's own ordering — its collation
        // decides where the name sorts — so only then is the list read again.
        $views = $replaces
            ? array_map(fn (array $existingView): array => $existingView['name'] === $name ? $view : $existingView, $existing)
            : $store->list($scope, $key);

        return ['view' => $view, 'views' => $views];
    }

    /**
     * Delete one of the calling operator's saved views (scoped — a foreign id is a no-op).
     *
     * @return array{views: list<array{id: string, name: string, state: array<string, mixed>}>}
     *
     * @throws AuthorizationException When the gate denies or no user is authenticated.
     * @throws InvalidArgumentException When the grid is unknown or declares no savedViews().
     */
    #[Renderless]
    public function gridViewDelete(string $grid, string $id): array
    {
        $definition = $this->viewableGrid($grid);

        $store = app(ViewStore::class);
        $scope = $this->viewScope();
        $key = $definition->getSavedViews()['key'];

        $store->delete($scope, $key, $id);

        return ['views' => $store->list($scope, $key)];
    }

    /**
     * Resolve + authorize a grid for the saved-views RPCs, requiring the ->savedViews()
     * declaration — a grid that never declared views must refuse the whole surface.
     *
     * @throws AuthorizationException|InvalidArgumentException
     */
    protected function viewableGrid(string $grid): Grid
    {
        $definition = $this->gridDefinition($grid);

        $this->authorizeGrid($definition);

        if ($definition->getSavedViews() === null) {
            throw new InvalidArgumentException("Grid [{$grid}] does not declare savedViews().");
        }

        return $definition;
    }

    /**
     * The opaque per-operator scope saved views live under. Minted from the authenticated
     * user only — guests have no durable identity to key views on, so the surface refuses.
     *
     * @throws AuthorizationException When no user is authenticated.
     */
    protected function viewScope(): string
    {
        $id = Auth::id();

        if ($id === null) {
            throw new AuthorizationException('Saved views require an authenticated user.');
        }

        return 'u:'.$id;
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

        $serverVersion = (int) ($this->laraGridVersions[$grid] ?? 0);
        $this->captureBaseline($grid, $definition, $rows);
        $result = app(OpApplier::class)->apply($definition, $rows, $batch, $serverVersion);
        $this->laraGridVersions[$grid] = $result->version;
        $applied = $this->trackRowChanges($grid, $definition, $result->rows, $result->inserted, $result->removed);

        // Write the authoritative rows back to the host property so save() + a possible re-render
        // read the applied state (cast values, recomputed formulas, row structure).
        $this->{$property} = $applied;

        // Drop Renderless when host chrome must refresh (G6) — see the method docblock: the
        // attribute hook already stored 'skipRender' BEFORE this method ran, so it must be
        // unset explicitly; forceRender() alone only guards against later skipRender() calls.
        if ($result->refreshHost) {
            $this->forceRender();
            store($this)->unset('skipRender');
        }

        $wire = $result->toArray();

        // Live grid-level validation (F5): one extra result entry, scoped 'rows', after the
        // per-op results. It is appended even when empty — that is how the client learns the
        // previous rows-scope messages are gone.
        if ($definition->validatesRowsLive()) {
            $messages = $this->runRowsValidator($definition, $this->keptRows($definition, $applied));
            $seqs = array_map(fn ($op): int => $op->seq, $batch->ops);
            $wire['results'][] = [
                'seq' => $seqs === [] ? 0 : max($seqs),
                'ok' => $messages === [],
                'scope' => 'rows',
                'patch' => [],
                'errors' => $messages,
            ];
        }

        return $wire;
    }

    /**
     * The rows a save keeps (blank trailing rows dropped) with their `_k` and `_labels` still
     * on — the row view a grid-level validator works on.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    protected function keptRows(Grid $definition, array $rows): array
    {
        $kept = count(app(RowSerializer::class)->cleanEditableRows($definition, $rows));

        return array_slice(array_values($rows), 0, $kept);
    }

    /**
     * Run the grid's ->validateRows() validator over kept rows and return its messages keyed
     * [rowKey|'_grid'][column|'_row'] (empty when none is declared or nothing failed).
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array<string, array<string, string>>
     */
    protected function runRowsValidator(Grid $definition, array $rows): array
    {
        $validator = $definition->getRowsValidator();
        if ($validator === null) {
            return [];
        }

        $context = new RowsContext($rows);
        $validator($context);

        return $context->messages();
    }

    /**
     * Rehydrate an opt-in browser draft into the new Livewire component after a reload.
     *
     * The browser payload is never assigned directly. Existing rows are matched by stable key,
     * new keys start from the definition's fresh-row template, and every writable value is run
     * through the normal OpApplier authorization/cast/validation/hooks/formula pipeline.
     *
     * @param  array{baseVersion?: int, rows?: list<array<string, mixed>>, lookups?: list<string>}  $payload
     * @return array{version: int, results: list<array<string, mixed>>, footer: array<string, int|float|string>, rows: list<array<string, mixed>>}
     */
    #[Renderless]
    public function gridRestoreDraft(string $grid, array $payload): array
    {
        $definition = $this->gridDefinition($grid);
        $this->authorizeGrid($definition);

        if (! $definition->isEditable()) {
            throw new InvalidArgumentException("Grid [{$grid}] is not editable; draft restoration is unavailable.");
        }

        $rawRows = $payload['rows'] ?? null;
        if (! is_array($rawRows)) {
            throw ValidationException::withMessages([$grid => 'The saved grid draft is malformed.']);
        }
        $limit = max(1, (int) config('laragrid.max_draft_rows', 10000));
        if (count($rawRows) > $limit) {
            throw ValidationException::withMessages([
                $grid => "The saved grid draft exceeds the {$limit}-row recovery limit.",
            ]);
        }

        $serverVersion = (int) ($this->laraGridVersions[$grid] ?? 0);
        if ((int) ($payload['baseVersion'] ?? 0) !== $serverVersion) {
            throw ValidationException::withMessages([
                $grid => 'The grid changed while its browser draft was being restored. Retry recovery.',
            ]);
        }

        $property = $definition->getRowsProperty();
        /** @var list<array<string, mixed>> $currentRows */
        $currentRows = $property !== null ? (array) ($this->{$property} ?? []) : [];
        $current = [];
        foreach ($currentRows as $row) {
            if (isset($row['_k'])) {
                $current[(string) $row['_k']] = $row;
            }
        }

        // Cells the browser pasted as a picker LABEL whose lookup was not acknowledged before the
        // reload (F3): their draft value is still the label, so the SET must resolve it again.
        $lookups = [];
        foreach ((array) ($payload['lookups'] ?? []) as $cellKey) {
            if (is_string($cellKey)) {
                $lookups[$cellKey] = true;
            }
        }

        $rows = [];
        $ops = [];
        $seen = [];
        $seq = 0;
        foreach (array_values($rawRows) as $index => $raw) {
            if (! is_array($raw)) {
                throw ValidationException::withMessages(["{$grid}.{$index}" => 'Draft row must be an object.']);
            }
            $key = isset($raw['_k']) ? (string) $raw['_k'] : '';
            if ($key === '' || strlen($key) > 190 || str_contains($key, "\x1F") || isset($seen[$key])) {
                throw ValidationException::withMessages([
                    "{$grid}.{$index}._k" => 'Draft row keys must be present, unique, and valid.',
                ]);
            }
            $seen[$key] = true;
            $rows[] = $current[$key] ?? $definition->makeNewRow($key);

            foreach ($definition->getColumns() as $column) {
                if (! $column->isWritable() || ! array_key_exists($column->key, $raw)) {
                    continue;
                }
                $op = [
                    't' => 'set',
                    'seq' => ++$seq,
                    'row' => $key,
                    'col' => $column->key,
                    'v' => $raw[$column->key],
                ];
                if (isset($lookups[$key."\x1F".$column->key])) {
                    $op['lookup'] = true;
                } elseif (isset($raw['_labels'][$column->key])) {
                    $op['label'] = (string) $raw['_labels'][$column->key];
                }
                $ops[] = $op;
            }
        }

        $batch = OpBatch::fromPayload(['baseVersion' => $serverVersion, 'ops' => $ops]);
        $this->captureBaseline($grid, $definition, $currentRows);
        $result = app(OpApplier::class)->apply($definition, $rows, $batch, $serverVersion);
        $wire = $result->toArray();
        // The draft replaces the row set wholesale: rows it lacks were removed, keys it brings
        // that the server lacked were inserted — the change set must see both (F6).
        $restoredRows = $result->rows;
        if ($definition->tracksChanges()) {
            $restoredRows = $this->trackRowChanges(
                $grid,
                $definition,
                $result->rows,
                [...$result->inserted, ...array_keys(array_diff_key($seen, $current))],
                [...$result->removed, ...array_values(array_diff_key($current, $seen))],
            );
        }
        $kept = app(RowSerializer::class)->cleanEditableRows($definition, $restoredRows);
        $finalErrors = [];
        if (count($kept) < $definition->getMinRows()) {
            $finalErrors['_grid']['_row'] = 'At least '.$definition->getMinRows().' line(s) required.';
        }
        $compiler = app(RuleCompiler::class);
        foreach (array_slice($restoredRows, 0, count($kept)) as $row) {
            foreach ($this->validateGridRow($definition, $compiler, $row) as $key => $columnMessages) {
                $finalErrors[(string) $row['_k']][$key] = $columnMessages[0];
            }
        }
        if ($finalErrors !== []) {
            $wire['results'][] = [
                'seq' => ++$seq,
                'ok' => false,
                'patch' => [],
                'errors' => $finalErrors,
            ];
        }
        if ($definition->getRowsValidator() !== null) {
            $rowsMessages = $this->runRowsValidator($definition, array_slice($restoredRows, 0, count($kept)));
            $wire['results'][] = [
                'seq' => ++$seq,
                'ok' => $rowsMessages === [],
                'scope' => 'rows',
                'patch' => [],
                'errors' => $rowsMessages,
            ];
        }
        $this->laraGridVersions[$grid] = $result->version;
        if ($property !== null) {
            $this->{$property} = $restoredRows;
        }

        return [
            ...$wire,
            'rows' => app(RowSerializer::class)->serializeMany($definition, $restoredRows),
        ];
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
        return $this->validatedGridRows($grid)[2];
    }

    /**
     * The change set of a tracked editable grid (->trackChanges(), F6) against its baseline —
     * the rows the document held when the host last loaded or saved it.
     *
     * What: Validates exactly as gridRows() does (and throws the same ValidationException),
     *       then sorts every kept row into `inserted` (not in the baseline), `updated` (in the
     *       baseline with at least one changed cell, listed in `changes` as {from, to}) or
     *       `unchanged`; `removed` lists baseline rows that are gone (or emptied) with their
     *       baseline values; `reordered` says whether the baseline rows changed order and
     *       `order` gives the kept row keys. Each `row` is a clean row, as gridRows() returns it.
     *       Values compare after the column's cast, so a seeded 10.0 equals the applied '10.00'.
     * Why:  An edit-existing-document screen must UPDATE, INSERT and DELETE lines, not rewrite
     *       them all; without this the host cannot tell a deleted-then-undone line from a new one.
     * When: In the host's save(); then markGridSaved() (or reseedGrid()) starts a new baseline.
     *       Protected: host code calls it, the browser cannot.
     *
     * @return array{
     *     inserted: list<array{key: string, row: array<string, mixed>}>,
     *     updated: list<array{key: string, row: array<string, mixed>, changes: array<string, array{from: mixed, to: mixed}>}>,
     *     removed: list<array{key: string, row: array<string, mixed>|null}>,
     *     unchanged: list<array{key: string, row: array<string, mixed>}>,
     *     reordered: bool,
     *     order: list<string>,
     * }
     *
     * @throws InvalidArgumentException When the grid is unknown, not editable, or untracked.
     * @throws ValidationException When the rows fail validation (as gridRows()).
     */
    protected function gridChanges(string $grid): array
    {
        [$definition, $kept, $clean] = $this->validatedGridRows($grid);

        if (! $definition->tracksChanges()) {
            throw new InvalidArgumentException("Grid [{$grid}] does not track changes; declare ->trackChanges() on it.");
        }

        $serializer = app(RowSerializer::class);
        $baselineKeys = $this->laraGridBaseline[$grid] ?? array_map(fn (array $row): string => (string) $row['_k'], $kept);
        $baseline = array_flip($baselineKeys);
        $changes = ['inserted' => [], 'updated' => [], 'removed' => [], 'unchanged' => [], 'reordered' => false, 'order' => []];

        $present = [];
        foreach ($kept as $index => $row) {
            $key = (string) $row['_k'];
            $present[$key] = true;
            $changes['order'][] = $key;
            if (! isset($baseline[$key])) {
                $changes['inserted'][] = ['key' => $key, 'row' => $clean[$index]];

                continue;
            }
            $cells = $this->changedCells($definition, $row);
            if ($cells === []) {
                $changes['unchanged'][] = ['key' => $key, 'row' => $clean[$index]];
            } else {
                $changes['updated'][] = ['key' => $key, 'row' => $clean[$index], 'changes' => $cells];
            }
        }

        // Baseline rows no longer kept: removed, or emptied into a blank trailing row.
        $property = $definition->getRowsProperty();
        $hostRows = [];
        foreach ($property !== null ? (array) ($this->{$property} ?? []) : [] as $row) {
            $hostRows[(string) ($row['_k'] ?? '')] = $row;
        }
        $removed = $this->laraGridRemoved[$grid] ?? [];
        foreach ($baselineKeys as $key) {
            if (isset($present[$key])) {
                continue;
            }
            $snapshot = $removed[$key] ?? (isset($hostRows[$key]) ? $this->originalRow($hostRows[$key]) : null);
            $changes['removed'][] = ['key' => $key, 'row' => $snapshot === null ? null : $serializer->cleanRow($snapshot)];
        }

        $stillKept = array_values(array_filter($baselineKeys, fn (string $key): bool => isset($present[$key])));
        $nowOrder = array_values(array_filter($changes['order'], fn (string $key): bool => isset($baseline[$key])));
        $changes['reordered'] = $stillKept !== $nowOrder;

        return $changes;
    }

    /**
     * Start a new change-tracking baseline after the host saved without reseeding: the current
     * kept rows become the baseline, their originals are forgotten and so are removed rows.
     */
    protected function markGridSaved(string $grid): void
    {
        $definition = $this->gridDefinition($grid);
        if (! $definition->tracksChanges() || ($property = $definition->getRowsProperty()) === null) {
            return;
        }

        $rows = $this->withoutOriginals((array) ($this->{$property} ?? []));
        $this->{$property} = $rows;
        $this->resetBaseline($grid, $definition, $rows);
    }

    /**
     * The validation body gridRows() and gridChanges() share: minRows, the per-row rules and
     * the grid-level validator, thrown as one ValidationException. Returns the definition, the
     * kept host rows (with `_k`) and their clean twins.
     *
     * @return array{0: Grid, 1: list<array<string, mixed>>, 2: list<array<string, mixed>>}
     */
    protected function validatedGridRows(string $grid): array
    {
        $definition = $this->gridDefinition($grid);

        if (! $definition->isEditable()) {
            throw new InvalidArgumentException("Grid [{$grid}] is not editable; gridRows is unavailable.");
        }

        $property = $definition->getRowsProperty();
        /** @var list<array<string, mixed>> $rows */
        $rows = $property !== null ? (array) ($this->{$property} ?? []) : [];

        $clean = app(RowSerializer::class)->cleanEditableRows($definition, $rows);
        if (count($clean) < $definition->getMinRows()) {
            throw ValidationException::withMessages([
                $grid => 'At least '.$definition->getMinRows().' line(s) required.',
            ]);
        }
        $messages = [];
        $compiler = app(RuleCompiler::class);

        foreach ($clean as $index => $row) {
            foreach ($this->validateGridRow($definition, $compiler, $row) as $key => $columnMessages) {
                $messages["{$grid}.{$index}.{$key}"] = $columnMessages;
            }
        }

        // Grid-level validation (F5): row keys map to the clean rows' indexes, so the host sees
        // `lines.2.item_id` exactly as for a cell rule, `lines.2` for a row and `lines` for the grid.
        $kept = array_slice(array_values($rows), 0, count($clean));
        $indexByKey = [];
        foreach ($kept as $index => $row) {
            $indexByKey[(string) ($row['_k'] ?? '')] = $index;
        }
        foreach ($this->runRowsValidator($definition, $kept) as $rowKey => $columns) {
            foreach ($columns as $column => $message) {
                $index = $indexByKey[(string) $rowKey] ?? null;
                $key = match (true) {
                    $index === null => $grid,
                    $column === '_row' => "{$grid}.{$index}",
                    default => "{$grid}.{$index}.{$column}",
                };
                $messages[$key] = [...($messages[$key] ?? []), $message];
            }
        }

        if ($messages !== []) {
            throw ValidationException::withMessages($messages);
        }

        return [$definition, $kept, $clean];
    }

    /**
     * Take a tracked grid's baseline the first time an op batch or a draft restore runs before
     * any mount/reseed set one: the rows on the server then are the document as loaded.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    protected function captureBaseline(string $grid, Grid $definition, array $rows): void
    {
        if ($definition->tracksChanges() && ! array_key_exists($grid, $this->laraGridBaseline)) {
            $this->resetBaseline($grid, $definition, $rows);
        }
    }

    /**
     * Make `$rows`' kept keys the baseline and forget every removed-row snapshot.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    protected function resetBaseline(string $grid, Grid $definition, array $rows): void
    {
        $this->laraGridBaseline[$grid] = array_map(
            fn (array $row): string => (string) ($row['_k'] ?? ''),
            $this->keptRows($definition, $rows),
        );
        $this->laraGridRemoved[$grid] = [];
    }

    /**
     * Fold a batch's structural ops into the change-tracking state: a removed baseline row is
     * remembered with its original values; a row re-inserted under a remembered key (an undo of
     * that remove) gets those values back as its originals, so it reads as unchanged once its
     * cells are restored. Untracked grids pass through untouched.
     *
     * @param  list<array<string, mixed>>  $rows  The applied rows.
     * @param  list<string>  $inserted
     * @param  list<array<string, mixed>>  $removedRows
     * @return list<array<string, mixed>>
     */
    protected function trackRowChanges(string $grid, Grid $definition, array $rows, array $inserted, array $removedRows): array
    {
        if (! $definition->tracksChanges()) {
            return $rows;
        }

        $baseline = array_flip($this->laraGridBaseline[$grid] ?? []);
        $removed = $this->laraGridRemoved[$grid] ?? [];
        foreach ($removedRows as $row) {
            $key = (string) ($row['_k'] ?? '');
            if (isset($baseline[$key]) && ! isset($removed[$key])) {
                $removed[$key] = $this->originalRow($row);
            }
        }

        if ($inserted !== [] && $removed !== []) {
            $returning = array_flip($inserted);
            foreach ($rows as $index => $row) {
                $key = (string) ($row['_k'] ?? '');
                if (! isset($returning[$key], $removed[$key])) {
                    continue;
                }
                $originals = [];
                foreach ($definition->getColumns() as $column) {
                    if ($column->isWritable()) {
                        $originals[$column->key] = $removed[$key][$column->key] ?? null;
                    }
                }
                $rows[$index]['_orig'] = $originals;
                unset($removed[$key]);
            }
        }

        $this->laraGridRemoved[$grid] = $removed;

        return $rows;
    }

    /**
     * A host row as it was at the baseline: every `_orig` value put back, `_orig` dropped.
     *
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    protected function originalRow(array $row): array
    {
        foreach ((array) ($row['_orig'] ?? []) as $key => $value) {
            $row[$key] = $value;
        }
        unset($row['_orig']);

        return $row;
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    protected function withoutOriginals(array $rows): array
    {
        return array_map(function (array $row): array {
            unset($row['_orig']);

            return $row;
        }, $rows);
    }

    /**
     * The cells of a kept baseline row whose value differs from its original, compared after
     * the column's cast (a seeded 10.0 and the applied '10.00' are the same decimal).
     *
     * @param  array<string, mixed>  $row
     * @return array<string, array{from: mixed, to: mixed}>
     */
    protected function changedCells(Grid $definition, array $row): array
    {
        $casts = app(CastRegistry::class);
        $cells = [];
        foreach ((array) ($row['_orig'] ?? []) as $key => $original) {
            $column = $definition->column((string) $key);
            if ($column === null) {
                continue;
            }
            $spec = $column->parseSpec();
            $kind = (string) ($spec['kind'] ?? 'text');
            $from = $casts->cast($kind, $original, $spec, $column);
            $to = $casts->cast($kind, $row[$key] ?? null, $spec, $column);
            if ($from !== $to) {
                $cells[(string) $key] = ['from' => $from, 'to' => $to];
            }
        }

        return $cells;
    }

    /**
     * Validate one row for the whole-grid passes (gridRows / gridRestoreDraft) and return the
     * failing columns' messages, in declared column order.
     *
     * What: Columns whose rules are plain, self-contained checks share ONE Validator for the
     *       row; any other column keeps its own Validator, exactly as every column did before.
     *       Columns whose rules are exactly ['nullable'] cannot fail and build nothing.
     * Why:  A Validator per cell made a 200-row × 10-column save build 2,000 validators. Sharing
     *       one is only safe when no rule can see or change another column's outcome: an
     *       exclude* rule on `meta` also skips every `meta.*` key validated in the same pass,
     *       and a closure or rule object may fail under another column's key ($fail('rate',
     *       …)) or inspect the validator. Those columns stay isolated, so every message is
     *       identical to the per-cell result (pinned by tests/Feature/RowValidationTest).
     * When: Once per kept row on save (gridRows) and in the draft-restore final pass.
     *
     * @param  array<string, mixed>  $row
     * @return array<string, list<string>> column key => messages (failing columns only)
     */
    protected function validateGridRow(Grid $definition, RuleCompiler $compiler, array $row): array
    {
        $shared = [];
        $isolated = [];
        $order = [];
        foreach ($definition->getColumns() as $column) {
            if (! $column->isEditable()) {
                continue;
            }
            $rules = $compiler->serverRules($column, $row);
            if ($rules === ['nullable']) {
                continue;
            }
            $order[] = $column->key;
            if ($this->rulesAreSelfContained($rules)) {
                $shared[$column->key] = $rules;
            } else {
                $isolated[$column->key] = $rules;
            }
        }

        $found = [];
        if ($shared !== []) {
            $errors = Validator::make($row, $shared)->errors();
            foreach (array_keys($shared) as $key) {
                $found[$key] = $errors->get($key);
            }
        }
        foreach ($isolated as $key => $rules) {
            $found[$key] = Validator::make($row, [$key => $rules])->errors()->get($key);
        }

        $messages = [];
        foreach ($order as $key) {
            if (($found[$key] ?? []) !== []) {
                $messages[$key] = array_values(array_map(
                    fn ($message): string => is_array($message) ? (string) ($message[0] ?? '') : (string) $message,
                    $found[$key],
                ));
            }
        }

        return $messages;
    }

    /**
     * Whether a column's rules may share a Validator with its row siblings without changing
     * any outcome: string rules other than exclude*, plus the In/NotIn objects laragrid's own
     * select columns emit (Laravel string-casts both before validating). A false negative only
     * costs a separate Validator; it never changes a message.
     *
     * @param  list<mixed>  $rules
     */
    protected function rulesAreSelfContained(array $rules): bool
    {
        foreach ($rules as $rule) {
            if ($rule instanceof In || $rule instanceof NotIn) {
                continue;
            }
            if (! is_string($rule) || preg_match('/(^|\|)\s*exclude/i', $rule) === 1) {
                return false;
            }
        }

        return true;
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

        // A fresh document has no baseline: every row it gains is an insert (F6).
        if ($definition->tracksChanges()) {
            $this->laraGridBaseline[$grid] = [];
            $this->laraGridRemoved[$grid] = [];
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

        // Change tracking (F6): the reseeded rows are the document as loaded — a new baseline,
        // with the bound property's originals forgotten.
        if ($definition->isEditable() && $definition->tracksChanges()) {
            $property = $definition->getRowsProperty();
            if ($property !== null) {
                $this->{$property} = $this->withoutOriginals((array) ($this->{$property} ?? []));
            }
            $this->resetBaseline($grid, $definition, $this->withoutOriginals($rows));
        }

        $this->laraGridVersions[$grid] = 0;
        $this->dispatch('lgrid:reseed', grid: $grid, rows: $serialized, footer: $footer);
    }

    /**
     * The current rows of an editable grid, for a mount that booted from a shell config.
     *
     * What: Serializes the rowsFrom()-bound property (the `config.rows` shape: `_k` and
     *       `_labels` intact, computeds baked), the footer as the flat {column: total} map,
     *       and the grid's CURRENT protocol version, which the client adopts so its next op
     *       batch matches. Unlike reseedGrid() it neither resets the version nor dispatches.
     * Why:  A host re-render sends a shell (rowsDeferred) for a grid the browser already
     *       mounted. If the browser nevertheless builds a NEW mount from that shell (a morph
     *       swapped the element), this is how it gets its rows. Renderless, authorized like
     *       every grid RPC.
     * When: Client boot, when the config carries `rowsDeferred: true`.
     *
     * @return array{rows: list<array<string, mixed>>, footer: array<string, int|float|string>, version: int}
     *
     * @throws AuthorizationException When the grid's ->authorize() gate denies.
     * @throws InvalidArgumentException When the grid is unknown, server-side, or not an editable rowsFrom() grid.
     */
    #[Renderless]
    public function gridReseedRows(string $grid): array
    {
        $definition = $this->gridDefinition($grid);

        if ($definition->isServerSide()) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] is server-side; its rows load through gridFetch, not gridReseedRows()."
            );
        }

        $property = $definition->getRowsProperty();
        if (! $definition->isEditable() || $property === null) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] is not an editable rowsFrom() grid; gridReseedRows is unavailable."
            );
        }

        $this->authorizeGrid($definition);

        /** @var list<array<string, mixed>> $rows */
        $rows = (array) ($this->{$property} ?? []);
        $serialized = app(RowSerializer::class)->serializeMany($definition, $rows);

        $footer = [];
        foreach ($definition->getFooter() as $aggregate) {
            $footer[$aggregate->column] = $aggregate->compute($serialized);
        }

        return [
            'rows' => $serialized,
            'footer' => $footer,
            'version' => (int) ($this->laraGridVersions[$grid] ?? 0),
        ];
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
            // Through the Gate facade, NOT $this->authorize(): the trait method only
            // exists on hosts using AuthorizesRequests, and Livewire 4 anonymous
            // components 403'd every update request through it (issue #4). Semantics are
            // identical on classic components — AuthorizesRequests::authorize() is itself
            // a Gate::authorize() wrapper — and the check stays fail-closed everywhere.
            Gate::authorize($gate);

            return;
        }

        $gate();
    }

    /**
     * Ask a SERVER-SIDE grid to re-fetch its CURRENT view — page, sort, search and
     * filters kept — with the client's page cache dropped (issue #5).
     *
     * What: The CRUD companion: create/update/delete a record (a modal, another
     *       component, a queued import), then `$this->refreshGrid('hotels')` — the grid
     *       reloads in place. No remount, no wire:key tricks; the client's PageSource
     *       clears its LRU cache and re-runs the current query through gridFetch, which
     *       re-authorizes as always.
     * Why: Dispatched as `lgrid:refresh` (a window DOM event via Livewire), the same
     *      host→client seam as `lgrid:reseed` — and like every fetch, the server stays
     *      the authority; this only asks the client to come back for fresh pages.
     * When: Server-side ->query() grids only. In-memory and editable grids don't fetch —
     *       hand them fresh rows via reseedGrid() instead (thrown loudly here).
     */
    protected function refreshGrid(string $grid): void
    {
        $definition = $this->gridDefinition($grid);

        if (! $definition->isServerSide()) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] is not server-side; refreshGrid() re-fetches a query() grid — "
                .'hand an in-memory or editable grid fresh rows via reseedGrid() instead.'
            );
        }

        $this->dispatch('lgrid:refresh', grid: $grid);
    }
}
