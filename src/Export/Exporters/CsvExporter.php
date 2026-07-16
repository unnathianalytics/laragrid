<?php

declare(strict_types=1);

namespace LaraGrid\Export\Exporters;

use LaraGrid\Export\ExportData;
use LaraGrid\Export\Exporter;
use RuntimeException;

/**
 * What: The dependency-free CSV writer — a UTF-8 BOM, one header row of column labels, the
 *       streamed data rows, and the totals row when the grid declares footer sums.
 *
 * Why:  CSV is the interchange floor every tool reads. The BOM is deliberate: without it,
 *       Excel (the audience for an accounting grid's export) mis-decodes UTF-8 as ANSI and
 *       ₹/₣/déjà-style labels corrupt. Numeric cells arrive RAW from the ExportBuilder
 *       (no thousands grouping) so spreadsheets parse them as numbers, not text — the same
 *       reason dates arrive as the grid's display strings (what the operator sees is what
 *       lands in the file). Rows write straight to the output stream: constant memory.
 *
 * When: Registered as 'csv' in the ExporterRegistry.
 */
final class CsvExporter implements Exporter
{
    public function extension(): string
    {
        return 'csv';
    }

    public function mimeType(): string
    {
        return 'text/csv; charset=UTF-8';
    }

    public function write(ExportData $data): void
    {
        $out = fopen('php://output', 'w');
        if ($out === false) {
            throw new RuntimeException('CSV export could not open the output stream.');
        }

        fwrite($out, "\xEF\xBB\xBF"); // UTF-8 BOM — Excel's decoding hint.

        $this->line($out, array_map(fn (array $column): string => $column['label'], $data->columns));

        foreach ($data->rows as $cells) {
            $this->line($out, $cells);
        }

        $totals = $data->totalsRow();
        if ($totals !== null) {
            $this->line($out, $totals);
        }

        fclose($out);
    }

    /**
     * One CSV record. Explicit separator/enclosure and a DISABLED escape character: PHP's
     * default backslash escape is a non-standard CSV dialect Excel mis-reads (and passing
     * it implicitly is deprecated from PHP 8.4); '' yields strict RFC 4180 quoting.
     *
     * @param  resource  $out
     * @param  list<int|float|string>  $cells
     */
    private function line($out, array $cells): void
    {
        fputcsv($out, array_map(
            fn (int|float|string $cell): string => is_string($cell) ? $cell : (string) $cell,
            $cells,
        ), ',', '"', '');
    }
}
