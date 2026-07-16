<?php

declare(strict_types=1);

namespace LaraGrid\Export;

/**
 * What: One export format — turns a compiled ExportData (columns + streamed rows + totals)
 *       into bytes on the current output stream, and names its file extension + MIME type.
 *
 * Why:  Exports are a registry of formats, not a hardcoded switch (the FormatRegistry /
 *       CastRegistry pattern — plan §3.11 portability): the core ships dependency-free
 *       csv/xlsx/pdf writers, and an app swaps or adds formats from its own provider
 *       (e.g. a dompdf-backed 'pdf' with full Unicode) without touching core. Writing to
 *       the output stream (not returning a string) keeps memory bounded on large exports —
 *       the trait wraps the call in response()->streamDownload().
 *
 * When: Resolved from the ExporterRegistry by WithLaraGrid::gridExport.
 */
interface Exporter
{
    /** The file extension (no dot) the download is named with, e.g. 'csv'. */
    public function extension(): string;

    /** The Content-Type header for the download response. */
    public function mimeType(): string;

    /**
     * Write the complete export to the current output stream (echo / php://output).
     *
     * Contract: iterate $data->rows exactly once, fully, BEFORE reading $data->totalsRow()
     * — totals accumulate while the rows stream (see ExportData).
     */
    public function write(ExportData $data): void;
}
