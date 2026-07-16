<?php

declare(strict_types=1);

namespace LaraGrid\Export;

use Closure;
use Illuminate\Database\Eloquent\Model;
use LaraGrid\Columns\Column;
use LaraGrid\Columns\ComputedColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Formatting\FormatRegistry;
use LaraGrid\Grid;
use LaraGrid\Query\AppliesFilters;
use LaraGrid\Query\AppliesSearch;
use LaraGrid\Query\AppliesSort;

/**
 * What: Compiles a readonly grid + the operator's CURRENT view (sort / search / filters, sent
 *       by the client exactly as gridFetch receives them) into the format-agnostic ExportData:
 *       the exportable columns, a lazy stream of resolved cell values over the WHOLE filtered
 *       set (never one page), and a running totals row for the grid's footer sums.
 *
 * Why:  An export is "the register I am looking at, complete": it must run through the SAME
 *       whitelisted narrowing pipeline as gridFetch (AppliesSort/Search/Filters — G12, the
 *       injection-closed contract), and export what the grid PAINTS — picker labels not ids,
 *       Y/N for yes-no cells, stripped text for html computeds, the date display pattern —
 *       while keeping summable numerics RAW so a spreadsheet can compute over them (only the
 *       PDF, a visual document, formats numbers). Rows stream via lazy() chunks under a hard
 *       row cap, so a huge table exports in bounded memory; totals accumulate during the same
 *       pass, so the totals row always equals the sum of the rows actually in the file (a
 *       capped export never claims the uncapped register total).
 *
 * When: Invoked by WithLaraGrid::gridExport inside the streamed download response.
 */
class ExportBuilder
{
    public function __construct(
        private readonly AppliesSort $sort = new AppliesSort,
        private readonly AppliesSearch $search = new AppliesSearch,
        private readonly AppliesFilters $filters = new AppliesFilters,
    ) {}

    /**
     * @param  array{sort?: string|null, dir?: string|null, search?: string|null, filters?: array<string, mixed>}  $request
     */
    public function build(Grid $grid, array $request): ExportData
    {
        $query = $grid->resolveQuery();

        // The same server-authoritative narrowing gridFetch applies — an export request
        // carries the client's current {sort, dir, search, filters} and nothing else
        // (page/perPage are meaningless here; unknown keys are ignored by the appliers).
        $this->sort->apply($query, $grid, $request);
        $this->search->apply($query, $grid, $request);
        $this->filters->apply($query, $grid, $request);

        // lazy() pages with limit/offset under the hood, so the order must be total — break
        // sort ties on the primary key or a chunk boundary could repeat/skip rows mid-file.
        $query->orderBy($query->getModel()->getQualifiedKeyName());

        $export = $grid->getExport() ?? [];
        $limit = max(1, (int) ($export['limit'] ?? 50000));
        $chunk = max(50, (int) config('laragrid.export.chunk', 500));

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

        $rows = (function () use ($query, $chunk, $limit, $resolvers, &$sums): \Generator {
            $ordinal = 0;
            foreach ($query->lazy($chunk)->take($limit) as $model) {
                $ordinal++;
                $cells = [];
                foreach ($resolvers as $index => $resolve) {
                    $value = $resolve($model, $ordinal);
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
     * @return Closure(Model, int): (int|float|string)
     */
    protected function cellResolver(Column $column): Closure
    {
        if ($column instanceof SerialColumn) {
            return fn (Model $model, int $ordinal): int => $ordinal;
        }

        if ($column instanceof ComputedColumn) {
            $strip = $column->isHtml();

            return function (Model $model) use ($column, $strip): string {
                $state = $column->resolveState($model->toArray());
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

            return function (Model $model) use ($key, $labels): string {
                $value = data_get($model, $key);
                if ($value === null || $value === '') {
                    return '';
                }

                return $labels[(string) $value] ?? (string) $value;
            };
        }

        if ($column->painterId() === 'checkbox') {
            return function (Model $model) use ($key): string {
                $value = data_get($model, $key);

                return $value === null || $value === '' ? '' : ($this->truthy($value) ? 'Yes' : 'No');
            };
        }

        // Y/N cells: blank until answered — an unanswered cell must not export as an explicit No.
        if ($column->painterId() === 'yesno') {
            return function (Model $model) use ($key): string {
                $value = data_get($model, $key);

                return $value === null || $value === '' ? '' : ($this->truthy($value) ? 'Y' : 'N');
            };
        }

        // Summable numerics stay RAW (int/float/fixed-scale string) so CSV/XLSX cells compute;
        // the PDF formats them at paint time from the column's Format tag.
        if ($column->isSelectableNumeric()) {
            return function (Model $model) use ($key): int|float|string {
                $value = data_get($model, $key);
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

        return function (Model $model) use ($key, $format, $strip, $registry): string {
            $value = data_get($model, $key);
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
