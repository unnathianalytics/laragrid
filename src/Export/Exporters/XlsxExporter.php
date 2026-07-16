<?php

declare(strict_types=1);

namespace LaraGrid\Export\Exporters;

use LaraGrid\Export\ExportData;
use LaraGrid\Export\Exporter;
use RuntimeException;
use ZipArchive;

/**
 * What: A dependency-free XLSX writer — a minimal, valid SpreadsheetML package (workbook,
 *       one worksheet, a two-style stylesheet) zipped with ext-zip. Header + totals rows
 *       are bold; numeric cells are REAL number cells; strings are inline (no shared-strings
 *       table); column widths derive from the grid's declared pixel widths.
 *
 * Why:  The package's install story is `composer require` and nothing else — pulling
 *       PhpSpreadsheet (and its GD/intl weight) for a flat table would break that. A
 *       spreadsheet-grade export only genuinely needs typed number cells (so Excel can sum
 *       what the accountant just downloaded) and honest text cells; inline strings keep the
 *       writer single-pass and streaming-friendly. Apps needing rich sheets register their
 *       own 'xlsx' Exporter over this one.
 *
 * When: Registered as 'xlsx' in the ExporterRegistry. Requires ext-zip (ubiquitous; a clear
 *       RuntimeException names the fix when absent).
 */
final class XlsxExporter implements Exporter
{
    public function extension(): string
    {
        return 'xlsx';
    }

    public function mimeType(): string
    {
        return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    public function write(ExportData $data): void
    {
        if (! class_exists(ZipArchive::class)) {
            throw new RuntimeException(
                'XLSX export requires the zip PHP extension (ext-zip); enable it, or register your own '
                .'xlsx exporter on LaraGrid\Export\ExporterRegistry.'
            );
        }

        // ZipArchive needs a seekable file — build in a temp file, stream it out, delete.
        $path = tempnam(sys_get_temp_dir(), 'lgrid-xlsx');
        if ($path === false) {
            throw new RuntimeException('XLSX export could not create a temporary file.');
        }

        try {
            $zip = new ZipArchive;
            if ($zip->open($path, ZipArchive::OVERWRITE) !== true) {
                throw new RuntimeException('XLSX export could not open the temporary archive.');
            }

            $zip->addFromString('[Content_Types].xml', $this->contentTypesXml());
            $zip->addFromString('_rels/.rels', $this->packageRelsXml());
            $zip->addFromString('xl/workbook.xml', $this->workbookXml($data->title));
            $zip->addFromString('xl/_rels/workbook.xml.rels', $this->workbookRelsXml());
            $zip->addFromString('xl/styles.xml', $this->stylesXml());
            $zip->addFromString('xl/worksheets/sheet1.xml', $this->sheetXml($data));

            $zip->close();
            readfile($path);
        } finally {
            @unlink($path);
        }
    }

    // ---- Package parts ----------------------------------------------------------------------

    private function contentTypesXml(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            .'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            .'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            .'<Default Extension="xml" ContentType="application/xml"/>'
            .'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            .'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            .'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            .'</Types>';
    }

    private function packageRelsXml(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            .'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            .'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            .'</Relationships>';
    }

    private function workbookXml(string $title): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            .'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            .'<sheets><sheet name="'.$this->xml($this->sheetName($title)).'" sheetId="1" r:id="rId1"/></sheets>'
            .'</workbook>';
    }

    private function workbookRelsXml(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            .'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            .'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            .'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
            .'</Relationships>';
    }

    /**
     * Two cell styles only: 0 = normal, 1 = bold (header + totals). The gray125 fill and the
     * empty border/cellStyleXfs entries are the mandatory boilerplate Excel expects to exist.
     */
    private function stylesXml(): string
    {
        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            .'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            .'<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            .'<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
            .'<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
            .'<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            .'<cellXfs count="2">'
            .'<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            .'<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
            .'</cellXfs>'
            .'</styleSheet>';
    }

    // ---- The worksheet ------------------------------------------------------------------------

    private function sheetXml(ExportData $data): string
    {
        $xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            .'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';

        // Column widths: grid pixels ≈ 7px per Excel width unit (the Calibri-11 convention);
        // grow/unsized columns get a readable default.
        $xml .= '<cols>';
        foreach ($data->columns as $index => $column) {
            $units = $column['width'] !== null
                ? max(6, round($column['width'] / 7, 1))
                : 22;
            $n = $index + 1;
            $xml .= '<col min="'.$n.'" max="'.$n.'" width="'.$units.'" customWidth="1"/>';
        }
        $xml .= '</cols><sheetData>';

        // Number-cell eligibility is decided by the COLUMN, never by content sniffing — a
        // text cell that happens to look numeric ("00123", an item code) must stay a string
        // or Excel strips its leading zeros.
        $numeric = array_map(fn (array $column): bool => $column['numeric'], $data->columns);

        $rowNumber = 1;
        $xml .= $this->rowXml($rowNumber, array_map(
            fn (array $column): string => $column['label'],
            $data->columns,
        ), $numeric, bold: true);

        foreach ($data->rows as $cells) {
            $rowNumber++;
            $xml .= $this->rowXml($rowNumber, $cells, $numeric);
        }

        $totals = $data->totalsRow();
        if ($totals !== null) {
            $rowNumber++;
            $xml .= $this->rowXml($rowNumber, $totals, $numeric, bold: true);
        }

        return $xml.'</sheetData></worksheet>';
    }

    /**
     * One <row>: typed number cells (<v>) where the value is a real int/float (the builder's
     * raw numerics + serial ordinals + totals sums) or a numeric string on a numeric COLUMN
     * (fixed-scale decimals); everything else inline strings. Empty strings emit an empty
     * styled cell — leaner and identical in the sheet.
     *
     * @param  list<int|float|string>  $cells
     * @param  list<bool>  $numeric  Per-column number-cell eligibility for string values.
     */
    private function rowXml(int $rowNumber, array $cells, array $numeric, bool $bold = false): string
    {
        $style = $bold ? ' s="1"' : '';
        $xml = '<row r="'.$rowNumber.'">';

        foreach ($cells as $index => $cell) {
            $ref = $this->columnLetter($index + 1).$rowNumber;

            $isNumberCell = is_int($cell) || is_float($cell)
                || (($numeric[$index] ?? false) && $cell !== '' && is_numeric($cell));

            if ($isNumberCell) {
                $xml .= '<c r="'.$ref.'"'.$style.'><v>'.$this->number($cell).'</v></c>';
            } elseif ($cell === '') {
                $xml .= '<c r="'.$ref.'"'.$style.'/>';
            } else {
                $xml .= '<c r="'.$ref.'"'.$style.' t="inlineStr"><is><t xml:space="preserve">'
                    .$this->xml((string) $cell).'</t></is></c>';
            }
        }

        return $xml.'</row>';
    }

    private function number(int|float|string $value): string
    {
        if (is_string($value)) {
            return $value; // already a canonical decimal string (DecimalColumn's fixed scale)
        }
        if (is_int($value)) {
            return (string) $value;
        }

        // Plain non-scientific decimal — Excel rejects 1.0E-5 style floats in <v>.
        return rtrim(rtrim(sprintf('%.10F', $value), '0'), '.');
    }

    /** 1 → A, 26 → Z, 27 → AA … */
    private function columnLetter(int $number): string
    {
        $letters = '';
        while ($number > 0) {
            $remainder = ($number - 1) % 26;
            $letters = chr(65 + $remainder).$letters;
            $number = intdiv($number - 1, 26);
        }

        return $letters;
    }

    /** Excel sheet-name rules: ≤31 chars, none of []:*?/\ — and never empty. */
    private function sheetName(string $title): string
    {
        $name = trim((string) preg_replace('/[\[\]:*?\/\\\\]+/', ' ', $title));

        return mb_substr($name === '' ? 'Export' : $name, 0, 31);
    }

    private function xml(string $text): string
    {
        return htmlspecialchars($text, ENT_XML1 | ENT_QUOTES, 'UTF-8');
    }
}
