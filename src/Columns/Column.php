<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

use LaraGrid\Columns\Concerns\CanEdit;
use LaraGrid\Columns\Concerns\HasAlignment;
use LaraGrid\Columns\Concerns\HasFormat;
use LaraGrid\Columns\Concerns\HasWidth;
use LaraGrid\Filters\Filter;

/**
 * What: The abstract base for every grid column. Owns the identity + presentation state
 *       shared by all types (key, label, width, alignment, format, frozen, visibility,
 *       html opt-in) and defines the two hooks concrete types fill in: painterId() and
 *       serializeType().
 *
 * Why:  A column is a pure, serializable definition — it holds no data and does no rendering.
 *       Its whole job is to describe itself into config the client interprets (plan §2.1:
 *       "declarative bridge, no logic smuggling"). Concentrating the common fluent surface
 *       here keeps the nine concrete types tiny (just their default align/format/painter and
 *       any type-specific fragment), which is what makes adding a column "a new class" (§3.8).
 *
 * When: Extended by the M1 column set (Serial/Text/Integer/Decimal/Qty/Amount/Readonly/
 *       Date/Computed); each instance is created via ::make() on the host and handed to Grid.
 */
abstract class Column
{
    use CanEdit;
    use HasAlignment;
    use HasFormat;
    use HasWidth;

    /** The default label for the Busy-style end-of-list exit option (endOfListOption). */
    public const END_OF_LIST_DEFAULT = '<-- End of List -->';

    protected ?string $label = null;

    /**
     * The resolved label for the Busy-style "End of List" exit option shown at the top of this
     * (picker) column's dropdown on the blank trailing row, or null when not declared. Choosing it
     * fires the grid's complete-guard escape (lgrid:complete) instead of committing a value — the
     * operator's "I'm done adding lines, move on" gesture.
     */
    protected ?string $endOfListLabel = null;

    /**
     * Whether the "End of List" exit option appears even on a grid with NO filled rows (i.e. on
     * the very first blank row). Default false keeps Busy's item-entry behaviour (the exit only
     * shows once ≥1 real line exists); true is for grids whose entries are OPTIONAL — a footer
     * bill-sundry grid a voucher may legitimately carry zero of, so the operator must be able to
     * skip past it from the first row.
     */
    protected bool $endOfListAllowOnEmpty = false;

    /**
     * The name of a HOST panel this column's forward Enter/next commit hands off to, or null when the
     * commit advances normally. When set, committing this cell with a forward advance (Enter/Tab)
     * dispatches a bubbling `lgrid:panel` DOM event `{grid, panel, rowKey, advance}` INSTEAD of moving
     * the cursor; the host opens the named panel (e.g. the Busy "Item Add. Field / Description" popup)
     * and, when done, resumes the grid via `lgrid:panel-done` — the deferred advance then runs. Used
     * to make the tail cell (Rate) auto-open a per-line description modal (plan 2026-07-06-1727).
     */
    protected ?string $opensPanel = null;

    /** Left-frozen (sticky) column; M1 supports left-freeze only (plan scope). */
    protected bool $frozen = false;

    protected bool $visible = true;

    /**
     * When true the client renders this column's value as HTML (caller-sanitised), not
     * textContent. Off by default: renderers write textContent only unless opted in (G13).
     */
    protected bool $asHtml = false;

    /**
     * Server-side sort opt-in (readonly). false = not sortable; true = sort by this column's own
     * key; a string = sort by a different DB column (e.g. a join alias for a related name).
     */
    protected bool|string $sortable = false;

    /** Whether this column participates in the grid's global search (readonly). */
    protected bool $searchable = false;

    /**
     * The header filter attached to this column (M7, readonly grids): a funnel control in the
     * header cell drives it; the filter itself runs in the SAME server pipeline as grid-level
     * ->filters() (Grid::getFilters merges both), so attachment is purely a UI anchoring choice.
     */
    protected ?Filter $filter = null;

    /**
     * @param  string  $key  The row-array key this column reads; also its config identity.
     */
    final public function __construct(public readonly string $key)
    {
        $this->configureDefaults();
    }

    /**
     * @param  string  $key  The row-array key this column reads.
     */
    public static function make(string $key): static
    {
        return new static($key);
    }

    public function label(string $label): static
    {
        $this->label = $label;

        return $this;
    }

    public function frozen(bool $frozen = true): static
    {
        $this->frozen = $frozen;

        return $this;
    }

    public function visible(bool $visible = true): static
    {
        $this->visible = $visible;

        return $this;
    }

    /**
     * Opt this column into HTML rendering (caller is responsible for sanitisation — G13).
     */
    public function html(bool $html = true): static
    {
        $this->asHtml = $html;

        return $this;
    }

    /**
     * Opt this column into server-side sort (readonly). Pass a DB column string to sort by a
     * different column than the row key (e.g. ->sortable('item_groups.name') via a join).
     *
     * @param  bool|string  $column  true = sort by this column's key; string = sort by that DB column.
     */
    public function sortable(bool|string $column = true): static
    {
        $this->sortable = $column;

        return $this;
    }

    /**
     * Opt this column into the grid's global search (readonly).
     */
    public function searchable(bool $searchable = true): static
    {
        $this->searchable = $searchable;

        return $this;
    }

    public function isSortable(): bool
    {
        return $this->sortable !== false;
    }

    /**
     * The DB column to ORDER BY for this column: an explicit string override, else the key.
     */
    public function sortColumn(): string
    {
        return is_string($this->sortable) ? $this->sortable : $this->key;
    }

    public function isSearchable(): bool
    {
        return $this->searchable;
    }

    /**
     * Attach a header filter to this column (readonly grids). The filter's key stays its own
     * query-payload identity — it need not match the column key (e.g. an `item_group_id`
     * SelectFilter anchored on the displayed `itemGroup.name` column).
     */
    public function filterable(Filter $filter): static
    {
        $this->filter = $filter;

        return $this;
    }

    public function getFilter(): ?Filter
    {
        return $this->filter;
    }

    /**
     * Offer a Busy-style "End of List" exit option at the top of this picker column's dropdown.
     *
     * What: When enabled, the editable grid's client injects a synthetic option (default label
     *       `<-- End of List -->`) as the first entry of THIS column's dropdown — but only on a
     *       blank trailing row of a grid that already holds ≥1 real row. Choosing it does NOT
     *       write a value; it fires the grid's complete-guard escape (bubbling `lgrid:complete`),
     *       so the host forwards focus out of the grid to the next region.
     * Why:  Faithful to Busy's item-entry UX (see the voucher item grid): the operator ends line
     *       entry by picking a highlighted control row in the same combobox they were using, rather
     *       than tabbing out cell-by-cell. Declared per COLUMN (not per grid) because only the
     *       "line identity" picker (e.g. Item) should sprout the exit — a grid-level flag couldn't
     *       target one picker. Only honoured on picker columns (select/searchselect); the grid
     *       build-time check rejects it elsewhere (fail loud).
     * When: Editable LaraGrid entry grids whose host listens for `lgrid:complete`.
     *
     * @param  bool|string  $label  true = the default label; a string = a custom label; false = off.
     * @param  bool  $allowOnEmpty  When true, the exit shows even on the FIRST blank row of a grid
     *                              with no filled rows (for OPTIONAL entry grids like bill sundries);
     *                              default false keeps Busy's "only after ≥1 real line" behaviour.
     */
    public function endOfListOption(bool|string $label = true, bool $allowOnEmpty = false): static
    {
        $this->endOfListLabel = $label === false
            ? null
            : ($label === true ? self::END_OF_LIST_DEFAULT : $label);
        $this->endOfListAllowOnEmpty = $allowOnEmpty;

        return $this;
    }

    /**
     * The resolved end-of-list exit-option label, or null when the column does not offer one.
     */
    public function getEndOfListOption(): ?string
    {
        return $this->endOfListLabel;
    }

    /**
     * Whether the end-of-list exit shows even on an empty grid (see endOfListOption's $allowOnEmpty).
     */
    public function getEndOfListAllowOnEmpty(): bool
    {
        return $this->endOfListAllowOnEmpty;
    }

    /**
     * Declare that this column's forward Enter/next commit hands off to a HOST panel (see $opensPanel).
     *
     * Why: The item-entry grid's Rate cell must auto-open the "Item Add. Field / Description" popup on
     *      the Enter that would otherwise advance past it; the host owns the modal, so the column only
     *      names the panel and the JS engine dispatches `lgrid:panel` in place of the advance. Opt-in
     *      per column — grids that don't declare it keep the plain advance and a byte-identical config.
     *
     * @param  string  $panel  The panel name the host's `lgrid:panel` listener matches on.
     */
    public function opensPanel(string $panel): static
    {
        $this->opensPanel = $panel;

        return $this;
    }

    /**
     * The host panel name this column's forward commit hands off to, or null when it advances normally.
     */
    public function getOpensPanel(): ?string
    {
        return $this->opensPanel;
    }

    public function isFrozen(): bool
    {
        return $this->frozen;
    }

    public function isVisible(): bool
    {
        return $this->visible;
    }

    /**
     * The resolved header label — the explicit label, else a Title Case of the key.
     */
    public function resolvedLabel(): string
    {
        return $this->label ?? ucwords(str_replace(['_', '-'], ' ', $this->key));
    }

    /**
     * The client painter id — which paint routine renders this column's cells.
     *
     * Why: The renderer dispatches by this string (registry lookup), so a new column type
     *      picks an existing painter or ships a new one without the renderer knowing types.
     *      M1 columns are all display-only, so most reuse the generic 'text' painter.
     */
    abstract public function painterId(): string;

    /**
     * The type-specific config fragment (empty for most M1 display columns).
     *
     * @return array<string, mixed>
     */
    protected function serializeType(): array
    {
        return [];
    }

    /**
     * Whether keyboard navigation lands on this column's cells.
     *
     * Why: M2 navigation steps over non-navigable columns (the serial gutter, hidden columns)
     *      so the active cell only ever sits on a real value cell. This is the ONE skip
     *      predicate the client applies (StateStore.isNavigable); serializing it here — rather
     *      than sniffing the type in JS — keeps the client type-agnostic. M4 widens the notion
     *      (readonly/disabled cells) by overriding this without changing the JS engine.
     */
    public function isNavigable(): bool
    {
        return true;
    }

    /**
     * Whether this column's values participate in the status-bar Sum/Avg (a numeric column).
     *
     * Why: The Excel-style status bar (M2) sums the numeric cells in a selection. Marking the
     *      numeric columns by type on the server lets the client compute Sum/Count/Avg without
     *      guessing which columns are numbers. Count always reflects selected cells regardless.
     */
    public function isSelectableNumeric(): bool
    {
        return false;
    }

    /**
     * The client editor id for this column — which floating-editor class opens on it, or null
     * when the column is not editable (display-only).
     *
     * Why: Editing dispatches by this string (EditorRegistry lookup), so a new editable type
     *      picks an existing editor or ships a new one without the EditorManager knowing types
     *      (plan §3.8). Display-only types (Serial/Readonly/Computed/Formula/Hidden) return null.
     */
    public function editorId(): ?string
    {
        return null;
    }

    /**
     * How the client parses typed text into this column's model value, as a {kind, ...} tag the
     * JS parse.js interprets (mirrored by the server cast in the OpApplier). Empty for
     * non-editable columns.
     *
     * @return array<string, mixed>
     */
    public function parseSpec(): array
    {
        return [];
    }

    /**
     * Server rules a column TYPE contributes implicitly — beyond the author's ->rules() — e.g.
     * SelectColumn's embedded-whitelist in:, CheckboxColumn's boolean, DateColumn's strict
     * date_format. Appended by RuleCompiler::serverRules(); never projected to the client
     * (the client enforces these structurally through its editors).
     *
     * @return list<mixed>
     */
    public function implicitRules(): array
    {
        return [];
    }

    /**
     * Whether an editable grid lets the client open an editor on this column's cells.
     *
     * Why: A column is editable only if it declares an editor AND isn't statically readonly. A
     *      per-row readonly closure is resolved per row (isReadonlyFor); this is the static gate
     *      the client uses to decide edit landing, kept alongside `navigable` so the JS engine
     *      stays type-agnostic (plan §2.4 — the ONE skip predicate widened to editing).
     */
    public function isEditable(): bool
    {
        return $this->editorId() !== null && ! ($this->readonly === true);
    }

    /**
     * Whether the OpApplier accepts a client write to this column. Editable columns are writable;
     * display-only columns (Readonly/Formula/Computed, and Hidden unless ->writable()) reject
     * direct writes server-side (plan G12). Overridden by HiddenColumn.
     */
    public function isWritable(): bool
    {
        return $this->isEditable();
    }

    /**
     * Hook for concrete types to set their default alignment/format (called from __construct).
     */
    protected function configureDefaults(): void
    {
        //
    }

    /**
     * The complete declarative config fragment for this column.
     *
     * Why: The single serialization surface ConfigSerializer calls; folding the shared
     *      identity/presentation keys and the per-type fragment into one shape keeps the
     *      client's column interpreter uniform across types.
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $fragment = [
            'key' => $this->key,
            'type' => $this->typeName(),
            'label' => $this->resolvedLabel(),
            'align' => $this->align,
            'frozen' => $this->frozen,
            'visible' => $this->visible,
            'html' => $this->asHtml,
            'painter' => $this->painterId(),
            'navigable' => $this->isNavigable(),
            'selectableNumeric' => $this->isSelectableNumeric(),
            'sortable' => $this->isSortable(),
            'searchable' => $this->isSearchable(),
            'format' => $this->resolvedFormat()?->toArray(),
            ...$this->serializeWidth(),
            ...$this->serializeEditable(),
            ...$this->serializeType(),
        ];

        // Emitted only when declared (the golden-config anti-rot discipline).
        if ($this->filter !== null) {
            $fragment['filter'] = $this->filter->toArray();
        }

        // The Busy-style exit option label (endOfListOption) — same whenFilled discipline, so a
        // grid whose pickers never offer one keeps its golden config unchanged.
        if ($this->endOfListLabel !== null) {
            $fragment['endOfListOption'] = $this->endOfListLabel;

            // Only emit the empty-grid relaxation when set, so existing golden configs (which
            // never allowed it) stay byte-identical.
            if ($this->endOfListAllowOnEmpty) {
                $fragment['endOfListAllowOnEmpty'] = true;
            }
        }

        // The host-panel hand-off (opensPanel) — emitted only when declared so a grid that never
        // hands off to a panel keeps its golden config byte-identical.
        if ($this->opensPanel !== null) {
            $fragment['opensPanel'] = $this->opensPanel;
        }

        return $fragment;
    }

    /**
     * The editable fragment: the editor id, parse contract, static editable/writable gates, and
     * the required/readonly flags. A per-row (closure) required/readonly serializes as the
     * 'dynamic' sentinel so the client shows the server's per-row verdict rather than a wrong
     * static flag. Compiled validation rules are attached by ConfigSerializer via RuleCompiler
     * (kept out of the column so the compiler owns the client/server rule split — plan §2.4).
     *
     * @return array<string, mixed>
     */
    protected function serializeEditable(): array
    {
        return [
            'editor' => $this->editorId(),
            'editable' => $this->isEditable(),
            'writable' => $this->isWritable(),
            'parse' => $this->parseSpec(),
            'required' => $this->isRequiredDynamic() ? 'dynamic' : ($this->required === true),
            'readonly' => $this->readonlyIsDynamic() ? 'dynamic' : ($this->readonly === true),
            'maxLength' => $this->getMaxLength(),
            'case' => $this->getCaseTransform(),
            ...$this->serializeWhenFilled(),
            ...$this->serializeLockedWhen(),
            ...$this->serializeRequiredWhen(),
        ];
    }

    /**
     * The short type name emitted into config (e.g. 'amount' for AmountColumn) — the class
     * base name minus the "Column" suffix, lower-cased.
     */
    protected function typeName(): string
    {
        $base = class_basename(static::class);

        return mb_strtolower(str_ends_with($base, 'Column') ? substr($base, 0, -6) : $base);
    }
}
