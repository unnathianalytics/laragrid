<?php

declare(strict_types=1);

namespace LaraGrid\Export;

use ArrayIterator;
use Closure;
use Generator;
use Illuminate\Contracts\Support\Arrayable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\LazyCollection;
use InvalidArgumentException;
use Iterator;
use IteratorAggregate;
use LaraGrid\Columns\Column;
use LaraGrid\Columns\ComputedColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Formatting\FormatRegistry;
use LaraGrid\Grid;
use LaraGrid\Query\AppliesEagerLoads;
use LaraGrid\Query\AppliesFilters;
use LaraGrid\Query\AppliesSearch;
use LaraGrid\Query\AppliesSort;
use LaraGrid\Views\ViewState;
use Throwable;

/**
 * What: Compiles a readonly grid + the operator's CURRENT view into format-agnostic ExportData:
 *       the exportable columns, a lazy stream of resolved cell values over the trusted query or
 *       exportRows source, and a running totals row for the grid's footer sums.
 *
 * Why:  Query grids run through the SAME whitelisted narrowing pipeline as gridFetch; custom
 *       report resolvers see only normalized declared state and rebuild server-owned rows. Both
 *       export what the grid PAINTS — picker labels not ids, Y/N for yes-no cells, stripped text
 *       for html computeds, the date display pattern — while keeping summable numerics RAW so a
 *       spreadsheet can compute over them. Every source streams under a hard row cap; totals
 *       accumulate during that same pass and therefore cover exactly the rows in the file.
 *
 * When: Invoked by WithLaraGrid::gridExport inside the streamed download response.
 */
class ExportBuilder
{
    public function __construct(
        private readonly AppliesSort $sort = new AppliesSort,
        private readonly AppliesSearch $search = new AppliesSearch,
        private readonly AppliesFilters $filters = new AppliesFilters,
        private readonly ViewState $viewState = new ViewState,
        private readonly AppliesEagerLoads $eagerLoads = new AppliesEagerLoads,
    ) {}

    /**
     * @param  array{sort?: string|null, dir?: string|null, search?: string|null, filters?: array<string, mixed>}  $request
     */
    public function build(Grid $grid, array $request): ExportData
    {
        $export = $grid->getExport() ?? [];
        $limit = max(1, (int) ($export['limit'] ?? 50000));

        if ($grid->hasExportRowResolver()) {
            // Unlike query appliers, arbitrary host report code must never see the raw client
            // payload. Reduce it to the exact declared state contract before invoking the
            // trusted resolver. The resolver owns applying whichever intents its report supports.
            $source = $grid->resolveExportRows($this->normalizeResolverState($grid, $request));
        } elseif ($grid->isServerSide()) {
            $source = $this->queryRows($grid, $request);
        } else {
            throw new InvalidArgumentException(
                "Grid [{$grid->name}] has no trusted server export source; declare query() or exportRows()."
            );
        }

        $columns = $this->exportableColumns($grid);
        $resolvers = array_map(fn (Column $column): Closure => $this->cellResolver($column), $columns);

        // Footer sums restricted to exported columns; accumulated while rows stream so the
        // totals row is honest even when the row cap truncates the set.
        $sumKeys = [];
        foreach ($grid->getFooter() as $aggregate) {
            if ($aggregate->type === 'sum') {
                $sumKeys[$aggregate->column] = true;
            }
        }
        $sums = [];
        foreach ($columns as $index => $column) {
            if (isset($sumKeys[$column->key])) {
                $sums[$index] = 0;
            }
        }

        $rows = (function () use ($source, $limit, $resolvers, &$sums): Generator {
            $ordinal = 0;
            foreach ($this->take($source, $limit) as $sourceRow) {
                $row = $this->normalizeRow($sourceRow);
                $ordinal++;
                // The array view of a model is built at most once per row, on first demand
                // (only computed columns need it).
                $asArray = null;
                $arr = function () use ($row, &$asArray): array {
                    return $asArray ??= $this->rowArray($row);
                };
                $cells = [];
                foreach ($resolvers as $index => $resolve) {
                    $value = $resolve($row, $ordinal, $arr);
                    if (array_key_exists($index, $sums) && is_numeric($value)) {
                        $sums[$index] = $this->addExact($sums[$index], $value);
                    }
                    $cells[] = $value;
                }
                yield $cells;
            }
        })();

        $totals = function () use ($columns, &$sums): ?array {
            if ($sums === []) {
                return null;
            }
            $row = [];
            foreach (array_keys($columns) as $index) {
                $row[$index] = $sums[$index] ?? '';
            }
            // Label the totals row in the first unsummed column (usually the serial/name cell).
            foreach (array_keys($row) as $index) {
                if (! array_key_exists($index, $sums)) {
                    $row[$index] = 'Total';
                    break;
                }
            }

            return array_values($row);
        };

        return new ExportData(
            title: (string) ($export['fileName'] ?? $grid->name),
            columns: array_map(fn (Column $column): array => [
                'key' => $column->key,
                'label' => $column->resolvedLabel(),
                'align' => $column instanceof SerialColumn || $column->isSelectableNumeric() ? 'right' : 'left',
                'numeric' => $column->isSelectableNumeric(),
                'format' => $column->resolvedFormat(),
                'width' => $column->getWidth(),
            ], $columns),
            rows: $rows,
            totals: $totals,
            generatedAt: now()->format('d-m-Y H:i'),
        );
    }

    /**
     * The query-backed source: the same whitelisted appliers as gridFetch, streamed in chunks.
     *
     * What: Keyset paging (lazyById: `WHERE id > last ORDER BY id LIMIT n`) when the effective
     *       order is the primary key alone, that is no sort at all or the key column sorted, and
     *       the query shape allows it (keysetSafe()). Any other order pages with lazy() (LIMIT
     *       and OFFSET), with ties broken on the primary key. Relations behind dot-keyed columns
     *       are eager-loaded once per chunk.
     * Why:  With OFFSET the database walks past every earlier row again for each chunk, so the
     *       cost of a large export grows with the square of its length.
     *
     * @param  array{sort?: string|null, dir?: string|null, search?: string|null, filters?: array<string, mixed>}  $request
     * @return iterable<int, Model>
     */
    protected function queryRows(Grid $grid, array $request): iterable
    {
        $query = $grid->resolveQuery();

        $this->sort->apply($query, $grid, $request);
        $this->search->apply($query, $grid, $request);
        $this->filters->apply($query, $grid, $request);

        $chunk = max(50, (int) config('laragrid.export.chunk', 2000));
        $model = $query->getModel();

        // Each stream runs on a clone: lazy() writes its paging offset into the builder it
        // runs on, and the eager-load fallback below may need to start over from page one.
        if ($this->keysetSafe($query)) {
            $descending = ($query->getQuery()->orders[0]['direction'] ?? 'asc') === 'desc';
            $query->reorder();
            $stream = fn (): LazyCollection => $descending
                ? (clone $query)->lazyByIdDesc($chunk, $model->getQualifiedKeyName(), $model->getKeyName())
                : (clone $query)->lazyById($chunk, $model->getQualifiedKeyName(), $model->getKeyName());
        } else {
            // lazy() pages with LIMIT/OFFSET, so the order must be total: break sort ties on the
            // primary key or a chunk boundary could repeat or skip rows mid-file.
            $query->orderBy($model->getQualifiedKeyName());
            $stream = fn (): LazyCollection => (clone $query)->lazy($chunk);
        }

        $added = $this->eagerLoads->apply($query, $grid);

        return $added === [] ? $stream() : $this->streamWithFallback($query, $grid, $added, $stream);
    }

    /**
     * Whether keyset paging can replace OFFSET paging for this query.
     *
     * Why: lazyById() orders by the key alone and reads the last key back from each chunk, so
     *      the current order must already be the key alone (or absent), and the key must come
     *      back unambiguous: no join (a joined table's `id` can shadow the model's), no grouping
     *      or union, no host OFFSET (older Laravel versions re-apply it to every chunk), and a
     *      select list that carries the key.
     *
     * @param  Builder<covariant Model>  $query
     */
    private function keysetSafe(Builder $query): bool
    {
        $model = $query->getModel();
        $base = $query->getQuery();
        $keys = [$model->getKeyName(), $model->getQualifiedKeyName()];

        $orders = $base->orders ?? [];
        $keyOrder = $orders === []
            || (count($orders) === 1 && in_array($orders[0]['column'] ?? null, $keys, true));

        if (! $keyOrder || ! empty($base->joins) || ! empty($base->groups) || ! empty($base->havings)
            || ! empty($base->unions) || ! empty($base->offset)) {
            return false;
        }

        if ($base->columns === null) {
            return true;
        }

        $carriesKey = ['*', $model->getTable().'.*', ...$keys];
        foreach ($base->columns as $column) {
            if (in_array($column, $carriesKey, true)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Stream the rows; when the eager loads AppliesEagerLoads added make a chunk throw, carry
     * on without them.
     *
     * Why: The stream is consumed inside the download response, where a failure can no longer
     *      become an error page. The retry starts over and skips the rows already handed out,
     *      so the file still carries every row exactly once.
     *
     * @param  Builder<covariant Model>  $query
     * @param  list<string>  $added
     * @param  Closure(): LazyCollection<int, Model>  $stream
     * @return Generator<int, Model>
     */
    private function streamWithFallback(Builder $query, Grid $grid, array $added, Closure $stream): Generator
    {
        $sent = 0;

        try {
            foreach ($stream() as $model) {
                yield $model;
                $sent++;
            }

            return;
        } catch (Throwable $e) {
            $this->eagerLoads->fallBack($query, $grid, $added, $e);
        }

        foreach ($stream()->skip($sent) as $model) {
            yield $model;
        }
    }

    /**
     * Normalize raw client state before it crosses into arbitrary host report code.
     *
     * @param  array<string, mixed>  $request
     * @return array{sort: string|null, dir: string, search: string, filters: array<string, string>}
     */
    protected function normalizeResolverState(Grid $grid, array $request): array
    {
        $state = $this->viewState->sanitizeQuery($grid, $request);

        // ViewState knows declared column keys; exports additionally require an actually
        // sortable target, matching AppliesSort's query-backed whitelist.
        if ($state['sort'] !== null) {
            $column = $grid->column($state['sort']);
            if ($column === null || ! $column->isSortable()) {
                $state['sort'] = null;
            }
        }

        return [
            'sort' => $state['sort'],
            'dir' => $state['dir'],
            'search' => $state['search'],
            'filters' => $state['filters'],
        ];
    }

    /**
     * Lazily cap any iterable without pulling the first row beyond the configured limit.
     *
     * @param  iterable<array-key, mixed>  $rows
     * @return Generator<int, mixed>
     */
    protected function take(iterable $rows, int $limit): Generator
    {
        $iterator = $this->iterator($rows);
        $iterator->rewind();
        $taken = 0;

        while ($taken < $limit && $iterator->valid()) {
            yield $iterator->current();
            $taken++;

            if ($taken < $limit) {
                $iterator->next();
            }
        }
    }

    /**
     * Turn every PHP iterable shape into the Iterator needed by the exact lazy cap.
     *
     * @param  iterable<array-key, mixed>  $rows
     * @return Iterator<array-key, mixed>
     */
    protected function iterator(iterable $rows): Iterator
    {
        if (is_array($rows)) {
            return new ArrayIterator($rows);
        }

        if ($rows instanceof Iterator) {
            return $rows;
        }

        if ($rows instanceof IteratorAggregate) {
            $iterator = $rows->getIterator();

            return $iterator instanceof Iterator ? $iterator : $this->iterator($iterator);
        }

        throw new InvalidArgumentException('Unsupported export iterable type '.get_debug_type($rows).'.');
    }

    /**
     * Normalize supported row carriers while preserving Eloquent's attribute/cast access.
     *
     * @return Model|array<string, mixed>
     */
    protected function normalizeRow(mixed $row): Model|array
    {
        if ($row instanceof Model || is_array($row)) {
            return $row;
        }

        if ($row instanceof Arrayable) {
            return $row->toArray();
        }

        throw new InvalidArgumentException(
            'Export rows must be arrays, Eloquent models, or Laravel Arrayable objects; '.get_debug_type($row).' given.'
        );
    }

    /**
     * The columns an export carries: declared, visible, not opted out via ->exportable(false).
     * Synthetic chrome (_select/_actions) never exists on the definition, and HiddenColumn
     * is visible=false — both excluded by construction.
     *
     * @return list<Column>
     */
    protected function exportableColumns(Grid $grid): array
    {
        return array_values(array_filter(
            $grid->getColumns(),
            fn (Column $column): bool => $column->isVisible() && $column->isExportable(),
        ));
    }

    /**
     * Build the per-column value resolver ONCE (type/painter dispatch out of the row loop).
     * Each resolver returns int|float|numeric-string (raw, for numeric columns) or a display
     * string — exactly what the grid paints, minus the styling. The third argument hands a
     * computed column the row's array view, memoised per row by the caller.
     *
     * @return Closure(Model|array<string, mixed>, int, Closure(): array<string, mixed>): (int|float|string)
     */
    protected function cellResolver(Column $column): Closure
    {
        if ($column instanceof SerialColumn) {
            return fn (Model|array $row, int $ordinal): int => $ordinal;
        }

        if ($column instanceof ComputedColumn) {
            $strip = $column->isHtml();

            return function (Model|array $row, int $ordinal, Closure $asArray) use ($column, $strip): string {
                $state = $column->resolveState($asArray());
                $text = $state === null ? '' : (string) $state;

                return $strip ? $this->stripHtml($text) : $text;
            };
        }

        $key = $column->key;

        // Picker cells paint their LABEL, so the export carries the label too. Embedded
        // options resolve here; a server-options picker without a hit falls back to the raw
        // value (visible data beats a blank — the painter's own rule).
        if ($column->painterId() === 'select') {
            $labels = [];
            if (method_exists($column, 'getOptions')) {
                foreach ($column->getOptions() as $option) {
                    $labels[$option['value']] = $option['label'];
                }
            }

            return function (Model|array $row) use ($key, $labels): string {
                $value = data_get($row, $key);
                if ($value === null || $value === '') {
                    return '';
                }

                return $labels[(string) $value] ?? (string) $value;
            };
        }

        if ($column->painterId() === 'checkbox') {
            return function (Model|array $row) use ($key): string {
                $value = data_get($row, $key);

                return $value === null || $value === '' ? '' : ($this->truthy($value) ? 'Yes' : 'No');
            };
        }

        // Y/N cells: blank until answered — an unanswered cell must not export as an explicit No.
        if ($column->painterId() === 'yesno') {
            return function (Model|array $row) use ($key): string {
                $value = data_get($row, $key);

                return $value === null || $value === '' ? '' : ($this->truthy($value) ? 'Y' : 'N');
            };
        }

        // Summable numerics stay RAW (int/float/fixed-scale string) so CSV/XLSX cells compute;
        // the PDF formats them at paint time from the column's Format tag.
        if ($column->isSelectableNumeric()) {
            return function (Model|array $row) use ($key): int|float|string {
                $value = data_get($row, $key);
                if ($value === null || $value === '') {
                    return '';
                }
                if (is_int($value) || is_float($value)) {
                    return $value;
                }

                return is_numeric((string) $value) ? (string) $value : '';
            };
        }

        // Everything else exports its DISPLAY string: the column's Format when declared
        // (dates get the app's display pattern, app formats apply), else a plain cast;
        // ->html() text columns are stripped back to text.
        $format = $column->resolvedFormat();
        $strip = $column->isHtml();
        if ($format !== null && $format->name === 'text') {
            $format = null; // 'text' is the identity format — skip the registry round trip
        }
        $registry = $format !== null ? app(FormatRegistry::class) : null;

        return function (Model|array $row) use ($key, $format, $strip, $registry): string {
            $value = data_get($row, $key);
            if ($value === null || $value === '') {
                return '';
            }

            $text = $format !== null && $registry !== null
                ? $registry->format($format->name, $value, $format->args)
                : (is_scalar($value) ? (string) $value : '');

            return $strip ? $this->stripHtml($text) : $text;
        };
    }

    /**
     * @param  Model|array<string, mixed>  $row
     * @return array<string, mixed>
     */
    protected function rowArray(Model|array $row): array
    {
        return $row instanceof Model ? $row->toArray() : $row;
    }

    /**
     * Sum preserving exactness: integers stay integers (paise never ride a float); any
     * fractional operand switches the running total to float — Aggregate::compute's rule.
     */
    protected function addExact(int|float $total, int|float|string $value): int|float
    {
        if (is_string($value)) {
            $value = str_contains($value, '.') ? (float) $value : (int) $value;
        }

        return $total + $value;
    }

    /** Loose truthiness matching the client's parseBool (checkbox/yesno cells). */
    protected function truthy(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value) || is_float($value)) {
            return $value != 0;
        }

        return in_array(mb_strtolower(trim((string) $value)), ['1', 'true', 'yes', 'y', 'on'], true);
    }

    /** An ->html() cell's text content: tags dropped, whitespace collapsed. */
    protected function stripHtml(string $html): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', strip_tags($html)));
    }
}
