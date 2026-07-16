<?php

declare(strict_types=1);

namespace LaraGrid\Export;

use Closure;
use LaraGrid\Formatting\Format;

/**
 * What: The compiled, format-agnostic export payload an Exporter consumes: a title, the
 *       exportable column metadata (label / alignment / numeric flag / display Format /
 *       width hint), a single-pass row iterable of resolved cell values, and a lazily
 *       finalized totals row.
 *
 * Why:  Every exporter (csv/xlsx/pdf/app-registered) must agree on WHAT is exported — the
 *       ExportBuilder resolves values once (labels for pickers, Y/N for yes-no, stripped
 *       text for html computeds, raw numerics for summable columns) and each exporter only
 *       decides how bytes look. Rows are an iterable (a lazy() generator in production) so
 *       a 50k-row export never holds 50k models; totals therefore accumulate DURING the
 *       stream and are only readable after it ends — the one-pass contract every writer
 *       naturally follows (rows first, totals row last).
 *
 * When: Built by ExportBuilder inside the gridExport RPC; handed to Exporter::write().
 */
final class ExportData
{
    /**
     * @param  string  $title  Human title (grid name / fileName base) for sheet names + PDF headings.
     * @param  list<array{key: string, label: string, align: string, numeric: bool, format: Format|null, width: int|null}>  $columns
     * @param  iterable<int, list<int|float|string>>  $rows  Cell lists aligned to $columns; consume ONCE, fully.
     * @param  Closure(): (list<int|float|string>|null)  $totals  The totals row (aligned to $columns), or null
     *                                                            when the grid declares no footer. Valid only
     *                                                            after $rows has been fully consumed.
     * @param  string  $generatedAt  Pre-formatted generation timestamp (PDF heading / metadata).
     */
    public function __construct(
        public readonly string $title,
        public readonly array $columns,
        public readonly iterable $rows,
        private readonly Closure $totals,
        public readonly string $generatedAt,
    ) {}

    /**
     * The totals row — every cell '' except the summed columns (raw numerics) and the
     * leading "Total" label; null when the grid has no footer aggregates.
     *
     * @return list<int|float|string>|null
     */
    public function totalsRow(): ?array
    {
        return ($this->totals)();
    }
}
