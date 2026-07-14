<?php

declare(strict_types=1);

namespace LaraGrid;

use Closure;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use InvalidArgumentException;
use LaraGrid\Actions\Action;
use LaraGrid\Columns\Column;
use LaraGrid\Editing\RowContext;
use LaraGrid\Filters\Filter;

/**
 * What: The fluent builder + immutable-ish config object for a datagrid. Declares the
 *       columns, header groups, footer aggregates and the M1 chrome/layout options
 *       (sticky header, frozen columns, stripes, density, theme + row/cell class hooks),
 *       and self-validates its consistency at build time.
 *
 * Why:  A Grid is a pure PHP description the client renders from — the "Livewire owns truth,
 *       JS owns motion" boundary starts here (plan §2.1). Concentrating the definition in one
 *       fluent object (Filament-style) lets a host declare a whole grid in one expression and
 *       hand it to <x-laragrid>; the boot-time self-checks fail loudly in local/testing on
 *       a mistake (duplicate keys, a group naming a missing column, over-freezing) that would
 *       otherwise surface as a confusing client render.
 *
 * When: Built in a host component's grid method (e.g. DatagridDemo::displayGrid()) and
 *       passed to the Blade component + ConfigSerializer.
 */
class Grid
{
    /** @var list<Column> */
    protected array $columns = [];

    /** @var list<ColumnGroup> */
    protected array $columnGroups = [];

    /** @var list<Aggregate> */
    protected array $footer = [];

    protected bool $stickyHeader = false;

    /** Number of left-frozen columns (sticky). */
    protected int $freezeColumns = 0;

    /**
     * The complete-guard declaration (completeWhenBalanced), or null when the grid never
     * completes: ['kind' => 'balanced', 'columns' => [debit, credit], 'autofill' => bool].
     *
     * @var array{kind: string, columns: list<string>, autofill: bool}|null
     */
    protected ?array $complete = null;

    protected bool $striped = false;

    /**
     * Keyboard navigation preset: 'entry' (serpentine, form-kit parity — the default operators
     * are trained on) or 'excel' (Enter moves down, Tab right). Interaction config, not data.
     */
    protected string $keymap = 'entry';

    /**
     * Status-bar toggle. null = auto (shown when the grid has any numeric/summable column, so
     * a selection's Sum/Count/Avg is available where it makes sense); true/false forces it.
     */
    protected ?bool $statusBar = null;

    /**
     * Default row density. Compact is the app-wide default (Tally-tight grids suit accountant
     * data entry); a caller opts out per-grid with ->density(GridDensity::Normal|Comfortable).
     */
    protected GridDensity $density = GridDensity::Compact;

    protected ?string $themeClass = null;

    /**
     * Layout persistence declaration (M7): ['mode' => 'local', 'key' => string], or null when
     * the grid does not persist operator widths/visibility.
     *
     * @var array{mode: string, key: string}|null
     */
    protected ?array $persist = null;

    /**
     * Optional per-row extra class resolver (runs server-side over the host row in M1).
     *
     * @var (Closure(array<string, mixed>): (string|null))|null
     */
    protected ?Closure $rowClassResolver = null;

    /**
     * Optional per-cell extra class resolver: fn(mixed $value, array $row, string $columnKey): ?string.
     *
     * @var (Closure(mixed, array<string, mixed>, string): (string|null))|null
     */
    protected ?Closure $cellClassResolver = null;

    // ---- Readonly (server-data) mode — M3 ------------------------------------------------

    /**
     * The host-supplied query factory for a readonly grid. Its presence is what makes a grid
     * "readonly server-side": rows come from this Builder through the QueryPipeline, paginated.
     *
     * A model-agnostic Eloquent Builder factory (the Grid is infrastructure shared across models,
     * so the builder is accepted covariantly — a host passes its own Builder<Item>, and the
     * QueryPipeline uses only generic Builder methods).
     *
     * @var (Closure(): Builder<covariant Model>)|null
     */
    protected ?Closure $queryResolver = null;

    /**
     * The authorization gate for this grid's RPCs — a Closure (typically fn () => $this->authorize(...))
     * or an ability string resolved against the host. Fail-closed: a readonly grid without one
     * throws at build time in local/testing (G12).
     *
     * @var (Closure(): mixed)|string|null
     */
    protected Closure|string|null $authorizeUsing = null;

    /**
     * Global-search target columns (raw DB columns LIKE-matched). Validated to be real column keys.
     *
     * @var list<string>
     */
    protected array $searchable = [];

    /**
     * Default sort: ['col' => key, 'dir' => 'asc'|'desc'], or null.
     *
     * @var array{col: string, dir: string}|null
     */
    protected ?array $defaultSort = null;

    /** Rows per page for a paginated readonly grid. */
    protected int $perPage = 50;

    /**
     * Selectable perPage options for the pagination control.
     *
     * @var list<int>
     */
    protected array $perPageOptions = [];

    /** @var list<Filter> */
    protected array $filters = [];

    /** The primary-key attribute used as each model row's stable client `_k`. */
    protected string $rowKey = 'id';

    // ---- Editable (in-memory) mode — M4 --------------------------------------------------

    /**
     * Whether this grid is editable. An editable grid holds the full row set client-side
     * (bound to a host `public array` via rowsFrom) and streams edits as ops through gridOps
     * to the OpApplier — it never paginates (plan G10). Distinct from a ->query() readonly grid.
     */
    protected bool $editable = false;

    /**
     * The host component property (a `public array $lines`-style attribute) that holds this
     * grid's rows. gridOps writes applied rows back to it, and gridRows() reads/cleans it for
     * save(). Required for an editable grid; the save path stays the host's (plan §3.1/§3.3).
     */
    protected ?string $rowsProperty = null;

    /** When ops leave the client for the server (plan G5). Default: per cell commit. */
    protected SyncPolicy $sync = SyncPolicy::PerCell;

    /**
     * Auto-append a blank trailing row so Enter past the last editable cell grows the grid
     * (Tally behaviour, plan G4). Blank trailing rows are excluded from validation and from
     * gridRows() at save.
     */
    protected bool $autoAppend = true;

    /** Minimum non-blank rows an editable grid must keep — a remove below this is rejected (G4). */
    protected int $minRows = 0;

    /**
     * Busy-style dedicated entry rows: the body is padded with inert blank rows so at least
     * this many rows are always visible. Pure presentation (pad rows never enter the row
     * model) — its job is to give editor popups grid space to open over instead of the page
     * chrome below a short grid.
     */
    protected int $padRows = 0;

    /**
     * Column keys whose edits must re-render host chrome (totals/tax panels living OUTSIDE the
     * grid). An op touching any of these drops gridOps's Renderless so Livewire re-renders the
     * host; the grid body is inside wire:ignore, so the morph is cheap and never disturbs it (G6).
     *
     * @var list<string>
     */
    protected array $refreshesHost = [];

    /**
     * Optional per-row activation URL resolver: fn(array $row): ?string. When set (readonly grids
     * only), RowSerializer bakes each row's resolved URL onto `_activateUrl`, and the client
     * activates a row (Enter / double-click) by dispatching `lgrid:activate` for the host to
     * navigate. Returning null (e.g. no update permission, a system row) leaves that row inert.
     *
     * @var (Closure(array<string, mixed>): (string|null))|null
     */
    protected ?Closure $rowActivate = null;

    /**
     * Optional server hook fired after a cell change is applied: fn(RowContext $row, string $col).
     *
     * @var (Closure(RowContext, string): void)|null
     */
    protected ?Closure $afterCellChangeHook = null;

    /**
     * Optional server hook fired after a row is removed: fn().
     *
     * @var (Closure(): void)|null
     */
    protected ?Closure $afterRowRemoveHook = null;

    // ---- P6 chained behaviors (zero-blade-config surface) --------------------------------

    /**
     * Toolbar declaration: null = enabled with config('laragrid.toolbar') defaults; false =
     * suppressed; an array of per-control overrides {search, filters, perPage, chooser}.
     *
     * @var array{search?: bool, filters?: bool, perPage?: bool, chooser?: bool}|false|null
     */
    protected array|false|null $toolbar = null;

    /** Focus the grid and activate its first navigable cell on mount. */
    protected bool $focusOnMount = false;

    /** CSS selector receiving focus when Tab leaves the grid past its last cell. */
    protected ?string $focusOutTo = null;

    /** CSS selector receiving focus when the complete-guard fires (retry built in client-side). */
    protected ?string $onCompleteFocus = null;

    /** Fixed grid height (any CSS length); the body scrolls inside it. */
    protected ?string $height = null;

    /** Max height override for the internal scroll box (defaults to 70vh in CSS). */
    protected ?string $maxHeight = null;

    /** Fill the parent box (100% height flex mode); pair with a sized container. */
    protected bool $fillParent = false;

    /** Empty-state text override (default: the package translation). */
    protected ?string $emptyState = null;

    /** Rows gridMountRows() seeds for a fresh editable grid (0 = host seeds manually). */
    protected int $defaultRows = 0;

    /**
     * Factory for a fresh row's default values (no `_k`; keys are merged over the
     * all-columns-null template). Used by gridMountRows() seeding AND the server's op INSERT.
     *
     * @var (Closure(): array<string, mixed>)|null
     */
    protected ?Closure $newRowUsing = null;

    /** @var list<Action> Per-row actions (trailing actions column). */
    protected array $rowActions = [];

    /** @var list<Action> Bulk actions over the checked-row set (selector gutter + toolbar bar). */
    protected array $bulkActions = [];

    /** @var list<Action> Toolbar buttons (grid-scoped, no row context). */
    protected array $toolbarActions = [];

    final public function __construct(public readonly string $name)
    {
        // App-wide defaults (config/laragrid.php) seed the per-grid state; any chained call
        // (->density(), ->keymap()) overrides them. Guarded parses: an invalid config value
        // falls back to the shipped default rather than shipping an unstyled/unknown preset.
        $this->density = GridDensity::tryFrom((string) config('laragrid.density', GridDensity::Compact->value))
            ?? GridDensity::Compact;

        $keymap = (string) config('laragrid.keymap', 'entry');
        $this->keymap = in_array($keymap, ['entry', 'excel'], true) ? $keymap : 'entry';
    }

    public static function make(string $name): static
    {
        return new static($name);
    }

    /**
     * @param  array<int, Column>  $columns  Re-indexed to a list (callers may pass a filtered array).
     */
    public function columns(array $columns): static
    {
        $this->columns = array_values($columns);

        return $this;
    }

    /**
     * @param  array<int, ColumnGroup>  $groups  Re-indexed to a list.
     */
    public function columnGroups(array $groups): static
    {
        $this->columnGroups = array_values($groups);

        return $this;
    }

    /**
     * @param  array<int, Aggregate>  $footer  Re-indexed to a list.
     */
    public function footer(array $footer): static
    {
        $this->footer = array_values($footer);

        return $this;
    }

    public function stickyHeader(bool $sticky = true): static
    {
        $this->stickyHeader = $sticky;

        return $this;
    }

    public function freezeColumns(int $count): static
    {
        $this->freezeColumns = max(0, $count);

        return $this;
    }

    public function striped(bool $striped = true): static
    {
        $this->striped = $striped;

        return $this;
    }

    /**
     * Choose the keyboard navigation preset: 'entry' = serpentine (default);
     * 'excel' = Enter-down/Tab-right. Validated so a typo fails loudly at build time.
     *
     * @throws InvalidArgumentException On an unknown preset.
     */
    public function keymap(string $keymap): static
    {
        if (! in_array($keymap, ['entry', 'excel'], true)) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] unknown keymap [{$keymap}]; expected 'entry' or 'excel'."
            );
        }

        $this->keymap = $keymap;

        return $this;
    }

    /**
     * Force the selection status bar on or off (default: auto — on when a numeric column exists).
     */
    public function statusBar(bool $show = true): static
    {
        $this->statusBar = $show;

        return $this;
    }

    public function density(GridDensity $density): static
    {
        $this->density = $density;

        return $this;
    }

    public function themeClass(string $class): static
    {
        $this->themeClass = $class;

        return $this;
    }

    /**
     * Persist operator layout changes (column widths + hidden columns) across visits.
     *
     * What: Enables the client LayoutStore under `lgrid:{key}` in localStorage (umbrella G9 v1).
     * Why:  Opt-in per grid so a definition that never expects layout tinkering stays free of
     *       stale storage; the key defaults to the grid name and is overridable for the rare
     *       page hosting two same-named grids. 'server' is the RESERVED user-preference-store
     *       mode (G9) — declaring it now is a hard error, not a silent no-op, so a host can
     *       never believe server persistence exists before it is built.
     * When: Declared on the definition; serialized into layout.persist only when enabled.
     *
     * @param  string  $mode  'local' (localStorage, v1). 'server' is reserved and throws.
     * @param  string|null  $key  Storage key override; defaults to the grid name.
     *
     * @throws InvalidArgumentException On the reserved 'server' mode or an unknown mode.
     */
    public function persistWidths(string $mode = 'local', ?string $key = null): static
    {
        if ($mode !== 'local') {
            throw new InvalidArgumentException(
                $mode === 'server'
                    ? "Grid [{$this->name}]: persistWidths('server') is reserved (G9) and not implemented — use 'local'."
                    : "Grid [{$this->name}]: unknown persistWidths mode [{$mode}] — use 'local'."
            );
        }

        $this->persist = ['mode' => 'local', 'key' => $key ?? $this->name];

        return $this;
    }

    /**
     * @param  Closure(array<string, mixed>): (string|null)  $resolver
     */
    public function rowClass(Closure $resolver): static
    {
        $this->rowClassResolver = $resolver;

        return $this;
    }

    /**
     * @param  Closure(mixed, array<string, mixed>, string): (string|null)  $resolver
     */
    public function cellClass(Closure $resolver): static
    {
        $this->cellClassResolver = $resolver;

        return $this;
    }

    // ---- Readonly (server-data) fluent surface — M3 -------------------------------------

    /**
     * Bind a readonly grid to a host query factory. The closure returns a fresh Eloquent Builder
     * each call (tenant-scoped by the host's global scope), which the QueryPipeline narrows +
     * paginates. Declaring a query switches the grid into server-side readonly mode.
     *
     * @param  Closure(): Builder<covariant Model>  $resolver  Any model's Builder (e.g. Builder<Item>).
     */
    public function query(Closure $resolver): static
    {
        $this->queryResolver = $resolver;

        return $this;
    }

    /**
     * Declare the grid's authorization gate — a Closure (fn () => $this->authorize('viewAny', X))
     * or an ability string the host resolves. Fail-closed for readonly grids (assertValid).
     *
     * @param  Closure(): mixed|string  $ability
     */
    public function authorize(Closure|string $ability): static
    {
        $this->authorizeUsing = $ability;

        return $this;
    }

    /**
     * Global-search target DB columns (LIKE-matched by AppliesSearch).
     *
     * @param  array<int, string>  $columns  Re-indexed to a list (callers may pass a filtered array).
     */
    public function searchable(array $columns): static
    {
        $this->searchable = array_values($columns);

        return $this;
    }

    /**
     * The default sort applied when a request carries no explicit sort. The column must be a
     * ->sortable() column (enforced at query time; a non-sortable default is simply ignored).
     */
    public function defaultSort(string $column, string $dir = 'asc'): static
    {
        $this->defaultSort = ['col' => $column, 'dir' => $dir === 'desc' ? 'desc' : 'asc'];

        return $this;
    }

    /**
     * Enable server-side pagination at $perPage rows, with optional selectable page sizes.
     *
     * @param  list<int>  $options  Selectable perPage sizes for the pagination control.
     */
    public function paginate(int $perPage, array $options = []): static
    {
        $this->perPage = max(1, $perPage);
        $this->perPageOptions = array_values(array_unique(array_map('intval', $options)));

        return $this;
    }

    /**
     * @param  array<int, Filter>  $filters  Re-indexed to a list (callers may pass a filtered array).
     */
    public function filters(array $filters): static
    {
        $this->filters = array_values($filters);

        return $this;
    }

    /**
     * The model attribute whose value becomes each server row's stable client `_k` (default 'id').
     */
    public function rowKey(string $primaryKey): static
    {
        $this->rowKey = $primaryKey;

        return $this;
    }

    // ---- Editable (in-memory) fluent surface — M4 ---------------------------------------

    /**
     * Mark this grid editable. Editable grids hold the full row set client-side and stream edits
     * as ops (plan G10 — no editable pagination in v1); rows come from the host prop named by
     * rowsFrom(), not a ->query(). Editable and ->query() are mutually exclusive modes.
     */
    public function editable(bool $editable = true): static
    {
        $this->editable = $editable;

        return $this;
    }

    /**
     * Bind the grid to the host property holding its rows (e.g. rowsFrom('lines') → $this->lines).
     * gridOps writes applied rows back here and gridRows() cleans it for the host's save().
     */
    public function rowsFrom(string $property): static
    {
        $this->rowsProperty = $property;

        return $this;
    }

    /**
     * Choose when queued ops flush to the server (plan G5). Default SyncPolicy::PerCell.
     */
    public function sync(SyncPolicy $policy): static
    {
        $this->sync = $policy;

        return $this;
    }

    /**
     * Toggle the trailing blank auto-append row (plan G4, default on for editable grids).
     */
    public function autoAppend(bool $autoAppend = true): static
    {
        $this->autoAppend = $autoAppend;

        return $this;
    }

    /**
     * Require at least $count non-blank rows; a remove that would drop below it is rejected (G4).
     */
    public function minRows(int $count): static
    {
        $this->minRows = max(0, $count);

        return $this;
    }

    /**
     * Pad the body with inert blank rows so at least $count rows are always visible
     * (Busy's dedicated entry rows). Visual only — never affects rows, ops, or save.
     */
    public function padRows(int $count): static
    {
        $this->padRows = max(0, $count);

        return $this;
    }

    /**
     * Declare the grid COMPLETE when two amount columns balance (Σ$debitColumn = Σ$creditColumn,
     * both > 0).
     *
     * What: A client-evaluable entry guard: while unbalanced, Enter past the last editable cell
     *       keeps auto-appending rows (unchanged); once balanced, the append is suppressed and
     *       the grid dispatches a bubbling `lgrid:complete` DOM event from its root instead, so
     *       the host can forward focus (e.g. to its Save button). With `$autofill` (default on),
     *       landing on an EMPTY, unlocked cell of the deficit-side column pre-fills it with the
     *       balancing amount through the normal commit pipeline — the operator accepts with
     *       Enter or overtypes.
     * Why:  The Busy fast-entry contract — the operator keeps adding Dr/Cr lines exactly until
     *       the voucher matches (the amount field suggesting the remaining difference each
     *       time), then Enter flows straight to Save. Declared as pure config (like
     *       whenFilled/padRows): the client only reads {kind, columns, autofill}; what
     *       "complete" triggers is the HOST's choice via the DOM event, keeping the grid
     *       host-agnostic.
     * When: Editable balanced-entry grids — the accounting voucher Dr/Cr line grid.
     */
    public function completeWhenBalanced(string $debitColumn, string $creditColumn, bool $autofill = true): static
    {
        $this->complete = [
            'kind' => 'balanced',
            'columns' => [$debitColumn, $creditColumn],
            'autofill' => $autofill,
        ];

        return $this;
    }

    /**
     * Declare the columns whose edits must re-render host chrome outside the grid (plan G6). An op
     * touching any listed column makes gridOps render (dropping Renderless) so the host re-paints;
     * the wire:ignore body is untouched by that morph.
     *
     * @param  array<int, string>  $columns  Re-indexed to a list.
     */
    public function refreshesHost(array $columns): static
    {
        $this->refreshesHost = array_values($columns);

        return $this;
    }

    /**
     * Make each row keyboard/double-click activatable to a per-row URL (readonly master lists).
     *
     * What: Registers a resolver `fn (array $row): ?string` run once per serialized row. Its return
     *       is baked onto the client row as `_activateUrl`; Enter (opt-in) and double-click on that
     *       row dispatch a `lgrid:activate` event the host handles (typically full-page navigation).
     * Why:  Route + permission resolution stays server-side (the client never builds a URL or learns
     *       what it means); returning null for a row (no update permission, a system/protected row)
     *       leaves it inert — the affordance mirrors the host's existing edit-link gate.
     * Ref:  RowSerializer bakes `_activateUrl`; ConfigSerializer advertises `layout.rowActivate`;
     *       the client RowActivator/KeyboardManager fire the event. Ignored on editable grids
     *       (there Enter/double-click open the editor).
     *
     * @param  Closure(array<string, mixed>): (string|null)  $resolver
     */
    public function rowActivate(Closure $resolver): static
    {
        $this->rowActivate = $resolver;

        return $this;
    }

    /**
     * Server hook fired after each applied cell change: fn(RowContext $row, string $col): void.
     * Used to keep host-side derived state in step (e.g. the voucher's "clear last printable").
     *
     * @param  Closure(RowContext, string): void  $hook
     */
    public function afterCellChange(Closure $hook): static
    {
        $this->afterCellChangeHook = $hook;

        return $this;
    }

    /**
     * Server hook fired after a row removal: fn(): void.
     *
     * @param  Closure(): void  $hook
     */
    public function afterRowRemove(Closure $hook): static
    {
        $this->afterRowRemoveHook = $hook;

        return $this;
    }

    // ---- P6 fluent surface ----------------------------------------------------------------

    /**
     * Control the package-rendered toolbar. Default (never called): enabled, controls per
     * config('laragrid.toolbar') gated by grid capability. ->toolbar(false) suppresses it;
     * named overrides tune single controls: ->toolbar(search: false).
     */
    public function toolbar(
        bool $enabled = true,
        ?bool $search = null,
        ?bool $filters = null,
        ?bool $perPage = null,
        ?bool $chooser = null,
    ): static {
        if (! $enabled) {
            $this->toolbar = false;

            return $this;
        }

        $this->toolbar = array_filter([
            'search' => $search,
            'filters' => $filters,
            'perPage' => $perPage,
            'chooser' => $chooser,
        ], fn (?bool $v): bool => $v !== null);

        return $this;
    }

    /** Focus the grid and activate its first navigable cell as soon as it mounts. */
    public function focusOnMount(bool $focus = true): static
    {
        $this->focusOnMount = $focus;

        return $this;
    }

    /** Send focus to $selector when Tab advances past the grid's last navigable cell. */
    public function focusOutTo(string $selector): static
    {
        $this->focusOutTo = $selector;

        return $this;
    }

    /**
     * Send focus to $selector when the complete-guard fires (completeWhenBalanced / end-of-list)
     * — the client retries briefly, so a button re-enabled by the same commit still receives it.
     */
    public function onCompleteFocus(string $selector): static
    {
        $this->onCompleteFocus = $selector;

        return $this;
    }

    /** Fix the grid's height (any CSS length); rows scroll inside it. */
    public function height(string $height): static
    {
        $this->height = $height;

        return $this;
    }

    /** Cap the scroll box (defaults to 70vh); the grid grows to content until the cap. */
    public function maxHeight(string $maxHeight): static
    {
        $this->maxHeight = $maxHeight;

        return $this;
    }

    /** Fill the parent element's box (flex column, 100% height). */
    public function fillParent(bool $fill = true): static
    {
        $this->fillParent = $fill;

        return $this;
    }

    /** Override the zero-rows message. */
    public function emptyState(string $text): static
    {
        $this->emptyState = $text;

        return $this;
    }

    /** Seed gridMountRows() with $count fresh rows for a new editable grid. */
    public function defaultRows(int $count): static
    {
        $this->defaultRows = max(0, $count);

        return $this;
    }

    /**
     * Declare the fresh-row factory: fn (): array of default values, merged over the
     * all-columns-null template. Shared by mount seeding and the op protocol's INSERT, so a
     * grown row carries the same defaults as a seeded one.
     *
     * @param  Closure(): array<string, mixed>  $factory
     */
    public function newRowUsing(Closure $factory): static
    {
        $this->newRowUsing = $factory;

        return $this;
    }

    /**
     * Per-row actions - buttons in a trailing actions column. url() actions bake their
     * resolved URL onto each row (`_actions`); call() actions round-trip through gridAction.
     *
     * @param  array<int, Action>  $actions
     */
    public function actions(array $actions): static
    {
        $this->rowActions = array_values($actions);

        return $this;
    }

    /**
     * Bulk actions - run over the checked-row keys; a selector gutter column appears and the
     * toolbar shows the bulk bar while any row is checked. call() only.
     *
     * @param  array<int, Action>  $actions
     */
    public function bulkActions(array $actions): static
    {
        $this->bulkActions = array_values($actions);

        return $this;
    }

    /**
     * Toolbar buttons - grid-scoped actions with no row context (New X, Export, ...).
     *
     * @param  array<int, Action>  $actions
     */
    public function toolbarActions(array $actions): static
    {
        $this->toolbarActions = array_values($actions);

        return $this;
    }

    /**
     * @return list<Action>
     */
    public function getActions(): array
    {
        return $this->rowActions;
    }

    /**
     * @return list<Action>
     */
    public function getBulkActions(): array
    {
        return $this->bulkActions;
    }

    /**
     * @return list<Action>
     */
    public function getToolbarActions(): array
    {
        return $this->toolbarActions;
    }

    /**
     * Locate an action by name across the three scopes - the gridAction RPC lookup.
     *
     * @return array{0: Action, 1: string}|null
     */
    public function findAction(string $name): ?array
    {
        $scopes = ['row' => $this->rowActions, 'bulk' => $this->bulkActions, 'toolbar' => $this->toolbarActions];
        foreach ($scopes as $scope => $set) {
            foreach ($set as $action) {
                if ($action->name === $name) {
                    return [$action, $scope];
                }
            }
        }

        return null;
    }

    // ---- P6 accessors -----------------------------------------------------------------------

    /**
     * The resolved toolbar controls for the client, or false when suppressed. Config defaults
     * overlaid by per-grid overrides; capability gating (searchable? filters?) stays client-side
     * so the shape is stable.
     *
     * @return array{search: bool, filters: bool, perPage: bool, chooser: bool}|false
     */
    public function getToolbar(): array|false
    {
        if ($this->toolbar === false) {
            return false;
        }

        $defaults = (array) config('laragrid.toolbar', []);

        return [
            'search' => (bool) ($this->toolbar['search'] ?? $defaults['search'] ?? true),
            'filters' => (bool) ($this->toolbar['filters'] ?? $defaults['filters'] ?? true),
            'perPage' => (bool) ($this->toolbar['perPage'] ?? $defaults['per_page'] ?? true),
            'chooser' => (bool) ($this->toolbar['chooser'] ?? $defaults['chooser'] ?? true),
        ];
    }

    public function getFocusOnMount(): bool
    {
        return $this->focusOnMount;
    }

    public function getFocusOutTo(): ?string
    {
        return $this->focusOutTo;
    }

    public function getOnCompleteFocus(): ?string
    {
        return $this->onCompleteFocus;
    }

    public function getHeight(): ?string
    {
        return $this->height;
    }

    public function getMaxHeight(): ?string
    {
        return $this->maxHeight;
    }

    public function getFillParent(): bool
    {
        return $this->fillParent;
    }

    public function getEmptyState(): ?string
    {
        return $this->emptyState;
    }

    public function getDefaultRows(): int
    {
        return $this->defaultRows;
    }

    /**
     * Build one fresh row: every declared (non-synthetic) column null, overlaid with the
     * newRowUsing() factory's defaults, keyed by the given `_k`. THE single blank-row shape —
     * used by the trait's mount seeding and the OpApplier's INSERT, so they can never diverge.
     *
     * @return array<string, mixed>
     */
    public function makeNewRow(string $key): array
    {
        $row = ['_k' => $key];
        foreach ($this->columns as $column) {
            if ($column->key === '' || str_starts_with($column->key, '_')) {
                continue; // serial gutter etc.
            }
            $row[$column->key] = null;
        }

        if ($this->newRowUsing !== null) {
            foreach (($this->newRowUsing)() as $columnKey => $value) {
                $row[$columnKey] = $value;
            }
        }

        return $row;
    }

    // ---- Editable accessors (serializer / applier / trait) ------------------------------

    /**
     * Whether this grid is editable (streams ops through gridOps to the OpApplier). Mutually
     * exclusive with server-side readonly mode.
     */
    public function isEditable(): bool
    {
        return $this->editable;
    }

    public function getRowsProperty(): ?string
    {
        return $this->rowsProperty;
    }

    public function getSyncPolicy(): SyncPolicy
    {
        return $this->sync;
    }

    public function autoAppends(): bool
    {
        return $this->autoAppend;
    }

    public function getMinRows(): int
    {
        return $this->minRows;
    }

    public function getPadRows(): int
    {
        return $this->padRows;
    }

    /**
     * The declared complete-guard spec, or null.
     *
     * @return array{kind: string, columns: list<string>, autofill: bool}|null
     */
    public function getCompleteSpec(): ?array
    {
        return $this->complete;
    }

    /**
     * @return list<string>
     */
    public function getRefreshesHost(): array
    {
        return $this->refreshesHost;
    }

    /**
     * The per-row activation URL resolver, or null when the grid is not row-activatable.
     *
     * @return (Closure(array<string, mixed>): (string|null))|null
     */
    public function getRowActivate(): ?Closure
    {
        return $this->rowActivate;
    }

    /** Whether a row-activation resolver is declared (drives `layout.rowActivate`). */
    public function hasRowActivate(): bool
    {
        return $this->rowActivate !== null;
    }

    /**
     * @return (Closure(RowContext, string): void)|null
     */
    public function getAfterCellChangeHook(): ?Closure
    {
        return $this->afterCellChangeHook;
    }

    /**
     * @return (Closure(): void)|null
     */
    public function getAfterRowRemoveHook(): ?Closure
    {
        return $this->afterRowRemoveHook;
    }

    /**
     * Resolve a column by its key, or null when the grid has no such column. Used by the OpApplier
     * to look up a column's cast/rules/write-policy for an incoming op.
     */
    public function column(string $key): ?Column
    {
        foreach ($this->columns as $column) {
            if ($column->key === $key) {
                return $column;
            }
        }

        return null;
    }

    // ---- Readonly accessors (serializer / pipeline / trait) -----------------------------

    /**
     * Whether this grid renders server-side paginated rows from a ->query() (vs. in-memory rows).
     */
    public function isServerSide(): bool
    {
        return $this->queryResolver !== null;
    }

    /**
     * Resolve a fresh query Builder from the host factory.
     *
     * @return Builder<covariant Model>
     *
     * @throws InvalidArgumentException When the grid has no ->query() (not a server-side grid).
     */
    public function resolveQuery(): Builder
    {
        if ($this->queryResolver === null) {
            throw new InvalidArgumentException("Grid [{$this->name}] has no query(); it is not a server-side grid.");
        }

        return ($this->queryResolver)();
    }

    /**
     * @return (Closure(): mixed)|string|null
     */
    public function getAuthorization(): Closure|string|null
    {
        return $this->authorizeUsing;
    }

    /**
     * @return list<string>
     */
    public function getSearchable(): array
    {
        return $this->searchable;
    }

    /**
     * @return array{col: string, dir: string}|null
     */
    public function getDefaultSort(): ?array
    {
        return $this->defaultSort;
    }

    public function getPerPage(): int
    {
        return $this->perPage;
    }

    /**
     * @return list<int>
     */
    public function getPerPageOptions(): array
    {
        return $this->perPageOptions;
    }

    /**
     * All filters — grid-level ->filters() plus any attached to a column via ->filterable()
     * (M7 header filters). One merged list so the query pipeline, the serializer and the
     * duplicate-key assert all see the same set regardless of where a filter was declared.
     *
     * @return list<Filter>
     */
    public function getFilters(): array
    {
        $columnFilters = [];
        foreach ($this->columns as $column) {
            $filter = $column->getFilter();
            if ($filter !== null) {
                $columnFilters[] = $filter;
            }
        }

        return [...$this->filters, ...$columnFilters];
    }

    public function getRowKey(): string
    {
        return $this->rowKey;
    }

    // ---- Accessors used by the serializer -------------------------------------------

    /**
     * @return list<Column>
     */
    public function getColumns(): array
    {
        return $this->columns;
    }

    /**
     * @return list<ColumnGroup>
     */
    public function getColumnGroups(): array
    {
        return $this->columnGroups;
    }

    /**
     * @return list<Aggregate>
     */
    public function getFooter(): array
    {
        return $this->footer;
    }

    public function isStickyHeader(): bool
    {
        return $this->stickyHeader;
    }

    public function getFreezeColumns(): int
    {
        return $this->freezeColumns;
    }

    public function isStriped(): bool
    {
        return $this->striped;
    }

    /**
     * The keyboard navigation preset ('entry' or 'excel'); validated on the way in.
     */
    public function getKeymap(): string
    {
        return $this->keymap;
    }

    /**
     * The resolved status-bar visibility: the explicit toggle when set, else auto — true when
     * any column is a summable numeric column (so Sum/Count/Avg is worth showing).
     */
    public function showsStatusBar(): bool
    {
        if ($this->statusBar !== null) {
            return $this->statusBar;
        }

        foreach ($this->columns as $column) {
            if ($column->isSelectableNumeric()) {
                return true;
            }
        }

        return false;
    }

    public function getDensity(): GridDensity
    {
        return $this->density;
    }

    public function getThemeClass(): ?string
    {
        return $this->themeClass;
    }

    /**
     * @return array{mode: string, key: string}|null
     */
    public function getPersist(): ?array
    {
        return $this->persist;
    }

    /**
     * @return (Closure(array<string, mixed>): (string|null))|null
     */
    public function getRowClassResolver(): ?Closure
    {
        return $this->rowClassResolver;
    }

    /**
     * @return (Closure(mixed, array<string, mixed>, string): (string|null))|null
     */
    public function getCellClassResolver(): ?Closure
    {
        return $this->cellClassResolver;
    }

    /**
     * Validate the grid's internal consistency.
     *
     * What: Rejects duplicate column keys, header groups naming a non-existent column, and a
     *       freeze count exceeding the column count.
     * Why:  These are author mistakes that produce a silently-wrong client render; failing at
     *       build time (invoked by the serializer, so it runs on every render in local/testing)
     *       turns them into a clear exception at the source. Kept a plain method (not env-gated
     *       here) so the serializer decides when to enforce — the demo/tests always enforce.
     *
     * @throws InvalidArgumentException On any inconsistency.
     */
    public function assertValid(): void
    {
        $keys = array_map(fn (Column $c): string => $c->key, $this->columns);

        $duplicates = array_keys(array_filter(array_count_values($keys), fn (int $n): bool => $n > 1));
        if ($duplicates !== []) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] has duplicate column keys: ".implode(', ', $duplicates).'.'
            );
        }

        $keySet = array_flip($keys);
        foreach ($this->columnGroups as $group) {
            foreach ($group->columns as $memberKey) {
                if (! isset($keySet[$memberKey])) {
                    throw new InvalidArgumentException(
                        "Grid [{$this->name}] group [{$group->label}] references unknown column [{$memberKey}]."
                    );
                }
            }
        }

        if ($this->freezeColumns > count($this->columns)) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] freezes {$this->freezeColumns} columns but only has ".count($this->columns).'.'
            );
        }

        if ($this->editable && $this->isServerSide()) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] cannot be both editable() and server-side query(); pick one mode."
            );
        }

        $this->assertReadonlyValid($keySet);
        $this->assertEditableValid($keySet);
        $this->assertActionsValid();
    }

    /**
     * Action invariants: unique names across the three scopes, exactly one kind per action,
     * bulk = call-only, and call()/bulk actions only where the server can resolve rows
     * authoritatively (an editable or ->query() grid - an in-memory display grid has no
     * server-side row source, so it may declare url() row actions only).
     */
    protected function assertActionsValid(): void
    {
        $names = [];
        $scopes = ['row' => $this->rowActions, 'bulk' => $this->bulkActions, 'toolbar' => $this->toolbarActions];
        foreach ($scopes as $scope => $set) {
            foreach ($set as $action) {
                $action->assertValid($this->name, $scope);

                if (isset($names[$action->name])) {
                    throw new InvalidArgumentException(
                        "Grid [{$this->name}] declares duplicate action name [{$action->name}]."
                    );
                }
                $names[$action->name] = true;

                $needsRows = ($scope === 'row' && $action->hasCall()) || $scope === 'bulk';
                if ($needsRows && ! $this->isEditable() && ! $this->isServerSide()) {
                    throw new InvalidArgumentException(
                        "Grid [{$this->name}] action [{$action->name}]: call()/bulk actions need an editable or query() grid."
                    );
                }
            }
        }
    }

    /**
     * Server-side (readonly) invariants.
     *
     * What: A readonly grid MUST declare ->authorize() (fail-closed, G12), its ->searchable()
     *       targets must be real column keys, and its ->defaultSort() column must exist. Filter
     *       keys must be unique.
     * Why:  The gridFetch RPC is a new data-access surface; an un-gated readonly grid could leak
     *       data, and a search/sort naming a phantom column is an author mistake best caught at
     *       build time (the serializer enforces this on every render in local/testing).
     *
     * @param  array<string, int>  $keySet  column key => index, from assertValid().
     */
    protected function assertReadonlyValid(array $keySet): void
    {
        if (! $this->isServerSide()) {
            return;
        }

        if ($this->authorizeUsing === null) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] is server-side but declares no authorize(); readonly grids must be gated (fail-closed)."
            );
        }

        foreach ($this->searchable as $column) {
            // A dot-qualified target (e.g. 'items.name') is an explicit DB column — used to
            // disambiguate under a join — not a column key, so it isn't validated against the
            // declared columns. Unqualified targets must be real column keys.
            if (! str_contains($column, '.') && ! isset($keySet[$column])) {
                throw new InvalidArgumentException(
                    "Grid [{$this->name}] searchable target [{$column}] is not a declared column."
                );
            }
        }

        if ($this->defaultSort !== null && ! isset($keySet[$this->defaultSort['col']])) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] defaultSort column [{$this->defaultSort['col']}] is not a declared column."
            );
        }

        // Validated over the MERGED set (grid-level + column-attached, M7) so a filter key can
        // never be declared twice across the two surfaces.
        $filterKeys = array_map(fn (Filter $f): string => $f->key, $this->getFilters());
        $dupes = array_keys(array_filter(array_count_values($filterKeys), fn (int $n): bool => $n > 1));
        if ($dupes !== []) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] has duplicate filter keys: ".implode(', ', $dupes).'.'
            );
        }
    }

    /**
     * Editable-mode invariants.
     *
     * What: An editable grid MUST declare ->authorize() (fail-closed, G12 — its gridOps RPC is a
     *       write surface) and MUST declare rowsFrom() (so the applier knows which host prop to
     *       write back and gridRows() knows what to clean). Every refreshesHost() column must be
     *       a real column key.
     * Why:  These are the mistakes that would make an editable grid silently un-savable or
     *       un-gated; failing at build time (the serializer enforces this on every render in
     *       local/testing) turns them into a clear exception at the source, exactly as the
     *       readonly path does.
     *
     * @param  array<string, int>  $keySet  column key => index, from assertValid().
     */
    protected function assertEditableValid(array $keySet): void
    {
        if (! $this->editable) {
            if ($this->defaultRows > 0 || $this->newRowUsing !== null) {
                throw new InvalidArgumentException(
                    "Grid [{$this->name}] declares defaultRows()/newRowUsing() but is not editable()."
                );
            }

            return;
        }

        if ($this->authorizeUsing === null) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] is editable but declares no authorize(); editable grids must be gated (fail-closed)."
            );
        }

        if ($this->rowsProperty === null) {
            throw new InvalidArgumentException(
                "Grid [{$this->name}] is editable but declares no rowsFrom(); it must bind to a host property."
            );
        }

        // (defaultRows/newRowUsing checked in the non-editable branch below; nothing here.)

        foreach ($this->refreshesHost as $column) {
            if (! isset($keySet[$column])) {
                throw new InvalidArgumentException(
                    "Grid [{$this->name}] refreshesHost() column [{$column}] is not a declared column."
                );
            }
        }

        // whenFilled() sibling targets must be real columns — a typo would silently no-op
        // client-side (the mirror writes to a key the renderer never paints).
        foreach ($this->columns as $column) {
            $targets = [...array_keys($column->getWhenFilledSets()), ...$column->getWhenFilledClears()];
            foreach ($targets as $target) {
                if (! isset($keySet[$target])) {
                    throw new InvalidArgumentException(
                        "Grid [{$this->name}] column [{$column->key}] whenFilled() references unknown column [{$target}]."
                    );
                }
            }
        }

        // lockedWhen()/requiredWhen() controlling columns must be real columns — a typo would
        // leave the rule permanently inert client-side (the predicate reads a row key that
        // never exists).
        foreach ($this->columns as $column) {
            foreach (['lockedWhen' => $column->getLockedWhen(), 'requiredWhen' => $column->getRequiredWhen()] as $rule => $spec) {
                if ($spec !== null && ! isset($keySet[$spec['column']])) {
                    throw new InvalidArgumentException(
                        "Grid [{$this->name}] column [{$column->key}] {$rule}() references unknown column [{$spec['column']}]."
                    );
                }
            }
        }

        // endOfListOption() is only meaningful on a picker column (select/searchselect) — it
        // injects a synthetic entry into that column's dropdown. On a non-picker column there is
        // no dropdown to host it, so the option would silently never appear: fail loud instead.
        foreach ($this->columns as $column) {
            if ($column->getEndOfListOption() !== null && ($column->parseSpec()['kind'] ?? null) !== 'select') {
                throw new InvalidArgumentException(
                    "Grid [{$this->name}] column [{$column->key}] declares endOfListOption() but is not a picker (select/searchselect) column."
                );
            }
        }

        // completeWhenBalanced() must name two real columns — a typo would sum a phantom key
        // to zero client-side and the guard would never fire.
        foreach ($this->complete['columns'] ?? [] as $completeColumn) {
            if (! isset($keySet[$completeColumn])) {
                throw new InvalidArgumentException(
                    "Grid [{$this->name}] completeWhenBalanced() references unknown column [{$completeColumn}]."
                );
            }
        }
    }
}
