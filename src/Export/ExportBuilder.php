<?php

declare(strict_types=1);

namespace LaraGrid\Export;

use ArrayIterator;
use Closure;
use Illuminate\Contracts\Support\Arrayable;
use Illuminate\Database\Eloquent\Model;
use InvalidArgumentException;
use Iterator;
use IteratorAggregate;
use LaraGrid\Columns\Column;
use LaraGrid\Columns\ComputedColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Formatting\FormatRegistry;
use LaraGrid\Grid;
use LaraGrid\Query\AppliesFilters;
use LaraGrid\Query\AppliesSearch;
use LaraGrid\Query\AppliesSort;
use LaraGrid\Views\ViewState;

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

        $rows = (function () use ($source, $limit, $resolvers, &$sums): \Generator {
            $ordinal = 0;
            foreach ($this->take($source, $limit) as $sourceRow) {
                $row = $this->normalizeRow($sourceRow);
                $ordinal++;
                $cells = [];
                foreach ($resolvers as $index => $resolve) {
                    $value = $resolve($row, $ordinal);
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
     * The existing query-backed source: same whitelist appliers and lazy chunking as before.
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

        // lazy() pages with limit/offset under the hood, so the order must be total — break
        // sort ties on the primary key or a chunk boundary could repeat/skip rows mid-file.
        $query->orderBy($query->getModel()->getQualifiedKeyName());

        return $query->lazy(max(50, (int) config('laragrid.export.chunk', 500)));
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
     * @return \Generator<int, mixed>
     */
    protected function take(iterable $rows, int $limit): \Generator
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
     * string — exactly what the grid paints, minus the styling.
     *
     * @return Closure(Model|array<string, mixed>, int): (int|float|string)
     */
    protected function cellResolver(Column $column): Closure
    {
        if ($column instanceof SerialColumn) {
            return fn (Model|array $row, int $ordinal): int => $ordinal;
        }

        if ($column instanceof ComputedColumn) {
            $strip = $column->isHtml();

            return function (Model|array $row) use ($column, $strip): string {
                $state = $column->resolveState($this->rowArray($row));
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
