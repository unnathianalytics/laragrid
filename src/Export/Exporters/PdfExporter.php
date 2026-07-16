<?php

declare(strict_types=1);

namespace LaraGrid\Export\Exporters;

use LaraGrid\Export\ExportData;
use LaraGrid\Export\Exporter;
use LaraGrid\Formatting\Format;
use LaraGrid\Formatting\FormatRegistry;

/**
 * What: A dependency-free PDF table writer — A4 (auto landscape for wide grids), a title +
 *       timestamp heading, a repeated bold header row, single-line rows with light rules,
 *       right-aligned formatted numerics, a bold totals row, and page numbers. Base-14
 *       Helvetica via WinAnsi encoding, real font metrics for fit/truncation/right-align,
 *       Flate-compressed streams when zlib is present.
 *
 * Why:  A PDF export is the "print the register" gesture — a visual document, so unlike
 *       csv/xlsx every value here is FORMATTED exactly as the grid paints it (the column's
 *       Format tag through the same FormatRegistry). Shipping it dependency-free keeps the
 *       package's one-line install honest; base-14 fonts mean no font files, at the cost of
 *       WinAnsi's Latin-1 repertoire (unmappable characters transliterate or degrade to '?').
 *       Apps needing full Unicode or branded layouts register their own 'pdf' Exporter
 *       (e.g. dompdf-backed) over this one — the definition-side API never changes.
 *
 * When: Registered as 'pdf' in the ExporterRegistry.
 */
final class PdfExporter implements Exporter
{
    private const PAGE_W = 595.28;   // A4 portrait, points

    private const PAGE_H = 841.89;

    private const MARGIN = 36.0;

    private const BODY_PT = 7.5;     // body/header font size

    private const ROW_H = 13.0;

    private const PAD = 3.0;         // horizontal cell padding

    /** Helvetica glyph widths (per-mille of the font size) for ASCII 32–126, AFM standard. */
    private const WIDTHS = [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
        1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
        333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
        556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
    ];

    /** Helvetica-Bold widths for ASCII 32–126. */
    private const WIDTHS_BOLD = [
        278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
        556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
        975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
        667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
        333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
        611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
    ];

    public function extension(): string
    {
        return 'pdf';
    }

    public function mimeType(): string
    {
        return 'application/pdf';
    }

    public function write(ExportData $data): void
    {
        // Orientation + column widths: grid px hints → points (px ≈ 0.75pt), scaled to fill
        // the usable width exactly (the spreadsheet "fit to page" rule). Wide grids flip to
        // landscape before scaling squeezes them.
        $hints = array_map(
            fn (array $column): float => $column['width'] !== null ? $column['width'] * 0.75 : 120.0,
            $data->columns,
        );
        $natural = array_sum($hints) ?: 1.0;

        $landscape = $natural > self::PAGE_W - 2 * self::MARGIN;
        $pageW = $landscape ? self::PAGE_H : self::PAGE_W;
        $pageH = $landscape ? self::PAGE_W : self::PAGE_H;
        $usable = $pageW - 2 * self::MARGIN;

        $widths = array_map(fn (float $hint): float => $hint / $natural * $usable, $hints);

        $registry = app(FormatRegistry::class);
        $pages = [];
        $page = '';
        $y = 0.0;

        $newPage = function (bool $first = false) use (&$page, &$pages, &$y, $data, $widths, $pageW, $pageH): void {
            if ($page !== '') {
                $pages[] = $page;
            }
            $page = '';
            $y = $pageH - self::MARGIN;

            // Page number (known immediately — no second pass).
            $n = count($pages) + 1;
            $page .= $this->text('Page '.$n, self::MARGIN, self::MARGIN - 14, 7, bold: false, gray: 0.45);

            if ($first) {
                $page .= $this->text($this->fit($data->title, $pageW - 2 * self::MARGIN, 13, true), self::MARGIN, $y - 13, 13, bold: true);
                $page .= $this->text($data->generatedAt, $pageW - self::MARGIN - $this->measure($data->generatedAt, 8, false), $y - 13, 8, bold: false, gray: 0.45);
                $y -= 26;
            }

            $y = $this->headerRow($page, $y, $data, $widths);
        };

        $newPage(first: true);

        $bottom = self::MARGIN + self::ROW_H; // keep at least one row of air above the fold
        foreach ($data->rows as $cells) {
            if ($y - self::ROW_H < $bottom) {
                $newPage();
            }
            $y = $this->bodyRow($page, $y, $cells, $data->columns, $widths, $registry, bold: false);
        }

        $totals = $data->totalsRow();
        if ($totals !== null) {
            if ($y - self::ROW_H < $bottom) {
                $newPage();
            }
            // A solid rule above the totals — the accountant's "double underline" cue, single here.
            $x2 = self::MARGIN + array_sum($widths);
            $page .= sprintf("0.25 G 0.8 w %.2F %.2F m %.2F %.2F l S\n", self::MARGIN, $y, $x2, $y);
            $y = $this->bodyRow($page, $y, $totals, $data->columns, $widths, $registry, bold: true);
        }

        $pages[] = $page;

        echo $this->assemble($pages, $pageW, $pageH, $data->title);
    }

    // ---- Table painting ------------------------------------------------------------------------

    /**
     * The bold column-label band + its underline. Returns the new y cursor.
     *
     * @param  list<float>  $widths
     */
    private function headerRow(string &$page, float $y, ExportData $data, array $widths): float
    {
        $baseline = $y - self::ROW_H + 3.5;
        $x = self::MARGIN;

        foreach ($data->columns as $index => $column) {
            $label = $this->fit($column['label'], $widths[$index] - 2 * self::PAD, self::BODY_PT, true);
            $textX = $column['align'] === 'right'
                ? $x + $widths[$index] - self::PAD - $this->measure($label, self::BODY_PT, true)
                : $x + self::PAD;
            $page .= $this->text($label, $textX, $baseline, self::BODY_PT, bold: true);
            $x += $widths[$index];
        }

        $y -= self::ROW_H;
        $page .= sprintf("0.25 G 0.8 w %.2F %.2F m %.2F %.2F l S\n", self::MARGIN, $y, $x, $y);

        return $y;
    }

    /**
     * One data (or totals) row: formatted values, per-column alignment, a light rule below.
     *
     * @param  list<int|float|string>  $cells
     * @param  list<array{key: string, label: string, align: string, numeric: bool, format: Format|null, width: int|null}>  $columns
     * @param  list<float>  $widths
     */
    private function bodyRow(
        string &$page,
        float $y,
        array $cells,
        array $columns,
        array $widths,
        FormatRegistry $registry,
        bool $bold,
    ): float {
        $baseline = $y - self::ROW_H + 3.5;
        $x = self::MARGIN;

        foreach ($cells as $index => $cell) {
            $column = $columns[$index] ?? null;
            if ($column === null) {
                break;
            }

            // The PDF is a visual document: numerics paint through the column's Format tag,
            // exactly as the grid's cells do (raw values were for the spreadsheet formats).
            $text = $cell;
            if (($column['numeric'] || $bold) && $column['format'] !== null && $text !== '' && is_numeric((string) $text)) {
                $text = $registry->format($column['format']->name, $text, $column['format']->args);
            }
            $text = $this->fit((string) $text, $widths[$index] - 2 * self::PAD, self::BODY_PT, $bold);

            if ($text !== '') {
                $textX = $column['align'] === 'right'
                    ? $x + $widths[$index] - self::PAD - $this->measure($text, self::BODY_PT, $bold)
                    : $x + self::PAD;
                $page .= $this->text($text, $textX, $baseline, self::BODY_PT, $bold);
            }
            $x += $widths[$index];
        }

        $y -= self::ROW_H;
        $page .= sprintf("0.85 G 0.4 w %.2F %.2F m %.2F %.2F l S\n", self::MARGIN, $y, self::MARGIN + array_sum($widths), $y);

        return $y;
    }

    /** One positioned text run (WinAnsi-encoded, PDF-escaped). */
    private function text(string $text, float $x, float $y, float $size, bool $bold, float $gray = 0.0): string
    {
        $encoded = $this->winAnsi($text);
        $encoded = str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $encoded);

        return sprintf(
            "BT /%s %.2F Tf %.2F g %.2F %.2F Td (%s) Tj ET\n",
            $bold ? 'F2' : 'F1',
            $size,
            $gray,
            $x,
            $y,
            $encoded,
        );
    }

    /** Truncate to a target width with a trailing ellipsis (measured, not guessed). */
    private function fit(string $text, float $maxWidth, float $size, bool $bold): string
    {
        $text = trim((string) preg_replace('/\s+/u', ' ', $text));
        if ($text === '' || $this->measure($text, $size, $bold) <= $maxWidth) {
            return $text;
        }

        $ellipsis = "\u{2026}";
        $budget = $maxWidth - $this->measure($ellipsis, $size, $bold);
        $kept = '';
        $used = 0.0;
        foreach (mb_str_split($text) as $char) {
            $w = $this->measure($char, $size, $bold);
            if ($used + $w > $budget) {
                break;
            }
            $kept .= $char;
            $used += $w;
        }

        return rtrim($kept).$ellipsis;
    }

    /** Text width in points at $size, via the embedded Helvetica metrics (WinAnsi bytes). */
    private function measure(string $text, float $size, bool $bold): float
    {
        $table = $bold ? self::WIDTHS_BOLD : self::WIDTHS;
        $units = 0;
        $bytes = $this->winAnsi($text);
        for ($i = 0, $n = strlen($bytes); $i < $n; $i++) {
            $byte = ord($bytes[$i]);
            // High-region (cp1252 accents, ₋dashes, ellipsis…) approximated at 556/611 —
            // the dominant Helvetica advance — keeps the table small with ≤2% drift.
            $units += $byte >= 32 && $byte <= 126 ? $table[$byte - 32] : ($bold ? 611 : 556);
        }

        return $units * $size / 1000;
    }

    /** UTF-8 → cp1252 (WinAnsi), transliterating where possible, '?' where not. */
    private function winAnsi(string $text): string
    {
        $converted = function_exists('iconv')
            ? @iconv('UTF-8', 'CP1252//TRANSLIT//IGNORE', $text)
            : false;
        if ($converted === false && function_exists('mb_convert_encoding')) {
            $converted = mb_convert_encoding($text, 'Windows-1252', 'UTF-8');
        }

        return $converted === false ? (string) preg_replace('/[^\x20-\x7E]/', '?', $text) : $converted;
    }

    // ---- Document assembly -----------------------------------------------------------------------

    /**
     * Assemble the object graph — catalog, pages tree, the two fonts, one page + one content
     * stream per painted page, the info dict — with a byte-exact xref table.
     *
     * @param  list<string>  $pages
     */
    private function assemble(array $pages, float $pageW, float $pageH, string $title): string
    {
        $compress = function_exists('gzcompress');

        // Fixed ids: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info; then [page, contents] pairs.
        $kids = [];
        foreach (array_keys($pages) as $i) {
            $kids[] = (6 + 2 * $i).' 0 R';
        }

        $objects = [
            1 => '<< /Type /Catalog /Pages 2 0 R >>',
            2 => '<< /Type /Pages /Kids ['.implode(' ', $kids).'] /Count '.count($pages)
                .sprintf(' /MediaBox [0 0 %.2F %.2F] >>', $pageW, $pageH),
            3 => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
            4 => '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
            5 => '<< /Title ('.str_replace(['\\', '(', ')'], ['\\\\', '\\(', '\\)'], $this->winAnsi($title)).')'
                .' /Producer (LaraGrid) /CreationDate (D:'.date('YmdHis').') >>',
        ];

        foreach ($pages as $i => $content) {
            $stream = $compress ? (string) gzcompress($content, 6) : $content;
            $filter = $compress ? ' /Filter /FlateDecode' : '';

            $objects[6 + 2 * $i] = '<< /Type /Page /Parent 2 0 R'
                .' /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >>'
                .' /Contents '.(7 + 2 * $i).' 0 R >>';
            $objects[7 + 2 * $i] = '<< /Length '.strlen($stream).$filter." >>\nstream\n".$stream."\nendstream";
        }

        // Serialize with byte-exact offsets — the xref table is what makes the file a PDF.
        $pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
        $offsets = [];
        ksort($objects);
        foreach ($objects as $id => $body) {
            $offsets[$id] = strlen($pdf);
            $pdf .= $id." 0 obj\n".$body."\nendobj\n";
        }

        $xrefAt = strlen($pdf);
        $count = count($objects) + 1;
        $pdf .= "xref\n0 {$count}\n0000000000 65535 f \n";
        foreach ($offsets as $offset) {
            $pdf .= sprintf("%010d 00000 n \n", $offset);
        }
        $pdf .= "trailer\n<< /Size {$count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{$xrefAt}\n%%EOF\n";

        return $pdf;
    }
}
