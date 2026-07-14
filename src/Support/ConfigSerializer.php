<?php

declare(strict_types=1);

namespace LaraGrid\Support;

use Illuminate\Database\Eloquent\Model;
use LaraGrid\Grid;
use LaraGrid\Query\QueryPipeline;
use LaraGrid\Validation\RuleCompiler;

/**
 * What: Compiles a Grid definition plus its host-supplied rows into the single declarative
 *       config array the client interprets — {name, columns[], groups[], footer[], layout{},
 *       rows[]}.
 *
 * Why:  This IS the declarative bridge (plan §2.1/§2.5): the client never invents columns,
 *       never computes, never formats logic it wasn't handed — it paints exactly what this
 *       array describes. Doing the readonly-M1 server work here (running ComputedColumn
 *       resolvers, applying row/cell class closures, pre-computing footer totals, synthesising
 *       a stable per-row `_k`) keeps the client dumb and keeps the output snapshot-testable —
 *       the golden-JSON anti-drift lock the plan mandates.
 *
 * When: Called by LaraGrid\View\DatagridComponent at render to build the @js() payload, and by
 *       ConfigSerializerTest against committed fixtures.
 */
class ConfigSerializer
{
    public function __construct(
        private readonly RowSerializer $rowSerializer = new RowSerializer,
        private readonly QueryPipeline $queryPipeline = new QueryPipeline,
        private readonly RuleCompiler $ruleCompiler = new RuleCompiler,
    ) {}

    /**
     * Serialize a grid + rows into the client config array.
     *
     * For a server-side (->query()) grid the `$rows` argument is ignored: page 1 is fetched
     * through the QueryPipeline at render (so first paint is round-trip-free, M3 decision), and
     * the footer + server meta carry the pipeline's authoritative page/grand totals. For an
     * in-memory grid (M1), `$rows` are the host-supplied rows and the footer sums them.
     *
     * @param  iterable<int, Model|array<string, mixed>>  $rows  Ignored for server-side grids.
     * @return array<string, mixed>
     */
    public function serialize(Grid $grid, iterable $rows = []): array
    {
        $grid->assertValid();

        $config = $grid->isServerSide()
            ? $this->serializeServerSide($grid)
            : $this->serializeInMemory($grid, $rows);

        // P7 actions - declarative meta only (labels/icons/confirm/kind; never closures).
        // Toolbar url() actions resolve once here (no row context).
        $actions = array_filter([
            'row' => array_map(fn ($a): array => $a->toArray(), $grid->getActions()),
            'bulk' => array_map(fn ($a): array => $a->toArray(), $grid->getBulkActions()),
            'toolbar' => array_map(
                fn ($a): array => $a->hasUrl() ? [...$a->toArray(), 'url' => $a->resolveUrl()] : $a->toArray(),
                $grid->getToolbarActions(),
            ),
        ], fn (array $set): bool => $set !== []);

        if ($actions !== []) {
            $config['actions'] = $actions;
        }

        return $config;
    }

    /**
     * The M1 path: in-memory host rows, footer sums them, no pagination/server meta.
     *
     * @param  iterable<int, Model|array<string, mixed>>  $rows
     * @return array<string, mixed>
     */
    protected function serializeInMemory(Grid $grid, iterable $rows): array
    {
        $rowList = $this->serializeRows($grid, $rows);

        return [
            'name' => $grid->name,
            'columns' => $this->serializeColumns($grid),
            'groups' => $this->serializeGroups($grid),
            'filters' => [],
            'footer' => $this->serializeFooter($grid, $rowList),
            'layout' => $this->serializeLayout($grid),
            'rows' => $rowList,
        ];
    }

    /**
     * The M3 path: fetch page 1 through the QueryPipeline; footer + server meta carry the
     * pipeline's page/grand totals; layout advertises server-side pagination.
     *
     * @return array<string, mixed>
     */
    protected function serializeServerSide(Grid $grid): array
    {
        $default = $grid->getDefaultSort();
        $page = $this->queryPipeline->run($grid, [
            'sort' => $default['col'] ?? null,
            'dir' => $default['dir'] ?? 'asc',
            'page' => 1,
            'perPage' => $grid->getPerPage(),
        ]);

        return [
            'name' => $grid->name,
            'columns' => $this->serializeColumns($grid),
            'groups' => $this->serializeGroups($grid),
            'filters' => array_map(fn ($filter): array => $filter->toArray(), $grid->getFilters()),
            'footer' => $this->serializeServerFooter($grid, $page->grandTotals),
            'layout' => $this->serializeLayout($grid),
            'rows' => $page->rows,
            'server' => [
                'total' => $page->total,
                'page' => $page->page,
                'perPage' => $page->perPage,
                'lastPage' => $page->lastPage(),
                'pageTotals' => $page->pageTotals,
                'grandTotals' => $page->grandTotals,
            ],
        ];
    }

    /**
     * The layout fragment, with M3 mode/pagination keys folded in (additive over M1/M2).
     *
     * @return array<string, mixed>
     */
    protected function serializeLayout(Grid $grid): array
    {
        $layout = [
            'stickyHeader' => $grid->isStickyHeader(),
            'freeze' => $grid->getFreezeColumns(),
            'striped' => $grid->isStriped(),
            'density' => $grid->getDensity()->value,
            'themeClass' => $grid->getThemeClass(),
            'keymap' => $grid->getKeymap(),
            'statusBar' => $grid->showsStatusBar(),
            'mode' => $this->resolveMode($grid),
            'serverSide' => $grid->isServerSide(),
            'editable' => $grid->isEditable(),
            'paginate' => $grid->isServerSide()
                ? ['perPage' => $grid->getPerPage(), 'options' => $grid->getPerPageOptions()]
                : null,
            'defaultSort' => $grid->getDefaultSort(),
            // Editable-mode config the client engine reads (null/defaults for non-editable grids).
            'sync' => $grid->isEditable() ? $grid->getSyncPolicy()->value : null,
            'autoAppend' => $grid->isEditable() && $grid->autoAppends(),
            'minRows' => $grid->isEditable() ? $grid->getMinRows() : 0,
            'refreshesHost' => $grid->getRefreshesHost(),
        ];

        // Emitted only when declared (the M6 whenFilled discipline) so the committed golden
        // configs of grids that never persist layout do not rot.
        if ($grid->getPersist() !== null) {
            $layout['persist'] = $grid->getPersist();
        }

        // Dedicated entry rows (Busy parity) — same whenFilled discipline as persist.
        if ($grid->getPadRows() > 0) {
            $layout['padRows'] = $grid->getPadRows();
        }

        // Row activation (readonly master lists): advertise that Enter/double-click on a row with
        // an `_activateUrl` should dispatch `lgrid:activate`. Emitted only when declared (whenFilled),
        // so grids that never activate keep their committed golden layout unchanged.
        if ($grid->hasRowActivate()) {
            $layout['rowActivate'] = true;
        }

        // Complete guard (balanced-entry grids): the client suppresses auto-append and signals
        // `lgrid:complete` once the two columns balance. Emitted only when declared.
        if ($grid->isEditable() && $grid->getCompleteSpec() !== null) {
            $layout['complete'] = $grid->getCompleteSpec();
        }

        // P6 behaviors — each emitted only when declared (golden-config discipline).
        $focus = array_filter([
            'onMount' => $grid->getFocusOnMount() ?: null,
            'outTo' => $grid->getFocusOutTo(),
            'complete' => $grid->getOnCompleteFocus(),
        ]);
        if ($focus !== []) {
            $layout['focus'] = $focus;
        }

        $sizing = array_filter([
            'height' => $grid->getHeight(),
            'maxHeight' => $grid->getMaxHeight(),
            'fill' => $grid->getFillParent() ?: null,
        ]);
        if ($sizing !== []) {
            $layout['sizing'] = $sizing;
        }

        if ($grid->getEmptyState() !== null) {
            $layout['emptyState'] = $grid->getEmptyState();
        }

        // The toolbar ships resolved (config defaults + per-grid overrides); false = suppressed.
        // Always emitted so the client never re-derives config defaults.
        $layout['toolbar'] = $grid->getToolbar();

        // The bulk selector gutter prepends a synthetic column, which would shift the declared
        // frozen set by one - compensate so freezeColumns keeps meaning "my first N declared".
        if ($grid->getBulkActions() !== [] && $grid->getFreezeColumns() > 0) {
            $layout['freeze'] = $grid->getFreezeColumns() + 1;
        }

        return $layout;
    }

    /**
     * The grid's client mode string: 'readonly' (server-side query), 'inline-editable' (editable
     * in-memory), or 'inline' (in-memory display). The client engine keys editor/sync construction
     * off this + the `editable` flag.
     */
    protected function resolveMode(Grid $grid): string
    {
        if ($grid->isServerSide()) {
            return 'readonly';
        }

        return $grid->isEditable() ? 'inline-editable' : 'inline';
    }

    /**
     * Server-side footer: each aggregate paints its grand total (authoritative, from the pipeline),
     * not a sum of the first page.
     *
     * @param  array<string, int|float>  $grandTotals
     * @return list<array<string, mixed>>
     */
    protected function serializeServerFooter(Grid $grid, array $grandTotals): array
    {
        return array_map(function ($aggregate) use ($grandTotals): array {
            return [
                'column' => $aggregate->column,
                'type' => $aggregate->type,
                'format' => $aggregate->resolvedFormat()?->toArray(),
                'value' => $grandTotals[$aggregate->column] ?? 0,
            ];
        }, $grid->getFooter());
    }

    /**
     * Serialize the columns, attaching each editable column's compiled `validate` block (the
     * declarative client rule subset + a serverOnly flag). The RuleCompiler owns the client/server
     * split so the column stays a pure declaration and the compiled shape lives in exactly one place.
     *
     * @return list<array<string, mixed>>
     */
    protected function serializeColumns(Grid $grid): array
    {
        $columns = array_map(function ($column): array {
            $fragment = $column->toArray();

            if ($column->isEditable()) {
                $fragment['validate'] = $this->ruleCompiler->toConfig($column);
            }

            return $fragment;
        }, $grid->getColumns());

        // P7 synthetic chrome columns: a leading rowselect gutter (bulk) and a trailing
        // actions cell (row actions). Non-navigable; underscore keys never reach the applier.
        if ($grid->getBulkActions() !== []) {
            array_unshift($columns, $this->syntheticColumn('_select', 'rowselect', 36, 'center'));
        }
        if ($grid->getActions() !== []) {
            $actionsColumn = $this->syntheticColumn('_actions', 'actions', 12 + 30 * count($grid->getActions()), 'right');
            // The painter needs each button's label/icon meta alongside the row's `_actions` bag.
            $actionsColumn['actions'] = array_map(fn ($a): array => $a->toArray(), $grid->getActions());
            $columns[] = $actionsColumn;
        }

        return $columns;
    }

    /**
     * A synthetic chrome column fragment in the exact shape Column::toArray() emits, so the
     * client renders it like any declared column.
     *
     * @return array<string, mixed>
     */
    protected function syntheticColumn(string $key, string $painter, int $width, string $align): array
    {
        return [
            'key' => $key,
            'type' => $painter,
            'label' => '',
            'align' => $align,
            'frozen' => false,
            'visible' => true,
            'html' => false,
            'painter' => $painter,
            'navigable' => false,
            'selectableNumeric' => false,
            'sortable' => false,
            'searchable' => false,
            'format' => null,
            'width' => $width,
            'resizable' => false,
            'editor' => null,
            'editable' => false,
            'writable' => false,
            'parse' => [],
            'required' => false,
            'readonly' => true,
            'maxLength' => null,
            'case' => null,
        ];
    }

    /**
     * Serialize header groups, resolving each group's member column indexes into a span so
     * the client can place the group cell without re-deriving positions.
     *
     * @return list<array<string, mixed>>
     */
    protected function serializeGroups(Grid $grid): array
    {
        $keyToIndex = [];
        foreach ($grid->getColumns() as $index => $column) {
            $keyToIndex[$column->key] = $index;
        }

        return array_map(function ($group) use ($keyToIndex): array {
            $indexes = array_map(fn (string $key): int => $keyToIndex[$key], $group->columns);
            sort($indexes);

            return [
                ...$group->toArray(),
                'start' => $indexes[0],
                'span' => count($indexes),
            ];
        }, $grid->getColumnGroups());
    }

    /**
     * @param  list<array<string, mixed>>  $rows  Already-serialized rows (footer sums their cells).
     * @return list<array<string, mixed>>
     */
    protected function serializeFooter(Grid $grid, array $rows): array
    {
        return array_map(fn ($aggregate): array => $aggregate->toArray($rows), $grid->getFooter());
    }

    /**
     * Serialize each host row via the shared RowSerializer — the single row-shaping path that
     * both the config's first page and every gridFetch page use, so the client row shape is
     * identical across a page swap (M3 decision record).
     *
     * @param  iterable<int, Model|array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    protected function serializeRows(Grid $grid, iterable $rows): array
    {
        return $this->rowSerializer->serializeMany($grid, $rows);
    }
}
