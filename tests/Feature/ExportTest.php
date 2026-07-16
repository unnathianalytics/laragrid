<?php

declare(strict_types=1);

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Export\ExportData;
use LaraGrid\Export\Exporter;
use LaraGrid\Export\ExporterRegistry;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\ExportItem;
use LaraGrid\Tests\Hosts\ServerGridComponent;
use Livewire\Livewire;

beforeEach(function () {
    Schema::create('export_items', function (Blueprint $table) {
        $table->id();
        $table->string('name');
        $table->string('code')->nullable();
        $table->string('type', 20)->nullable();
        $table->integer('qty')->default(0);
        $table->decimal('rate', 10, 2)->nullable();
        $table->boolean('active')->default(true);
        $table->date('booked_on')->nullable();
        $table->string('note')->nullable();
        $table->string('secret')->nullable();
        $table->timestamps();
    });

    // Values chosen to be binary-exact (x.25/x.50) so float sums stay artifact-free, plus a
    // quote and a comma in names (CSV quoting) and a leading-zero code (XLSX string typing).
    ExportItem::create(['name' => 'Anvil', 'code' => null, 'type' => 'service', 'qty' => 4, 'rate' => '100.00', 'active' => false, 'booked_on' => null, 'note' => 'n1', 'secret' => 's1']);
    ExportItem::create(['name' => 'Bolt', 'code' => '00123', 'type' => 'goods', 'qty' => 10, 'rate' => '12.50', 'active' => true, 'booked_on' => '2026-01-15', 'note' => 'n2', 'secret' => 's2']);
    ExportItem::create(['name' => 'Cable "A"', 'code' => '007', 'type' => 'goods', 'qty' => 6, 'rate' => '3.25', 'active' => true, 'booked_on' => '2026-02-01', 'note' => 'n3', 'secret' => 's3']);
});

/** Run gridExport directly and capture the streamed file bytes. */
function exportBytes(ServerGridComponent $component, string $format, array $query = []): string
{
    $response = $component->gridExport('items', $format, $query);

    ob_start();
    $response->sendContent();

    return (string) ob_get_clean();
}

/** Parse exported CSV into rows of fields (BOM stripped). */
function csvRows(string $csv): array
{
    $csv = (string) preg_replace('/^\xEF\xBB\xBF/', '', $csv);

    return array_map(
        fn (string $line): array => str_getcsv($line, ',', '"', ''),
        array_values(array_filter(explode("\n", trim($csv)))),
    );
}

// ---- Build-time rules ----------------------------------------------------------------------

it('rejects exportable() on a grid without query() at build time', function () {
    $grid = Grid::make('d')->columns([TextColumn::make('n')])->exportable();

    expect(fn () => $grid->assertValid())
        ->toThrow(InvalidArgumentException::class, 'exports need a server-side readonly grid');
});

it('rejects an unknown export format at build time', function () {
    $grid = Grid::make('items')
        ->query(fn () => ExportItem::query())
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')])
        ->exportable(['csv', 'tsv']);

    expect(fn () => $grid->assertValid())
        ->toThrow(InvalidArgumentException::class, 'unknown format [tsv]');
});

it('rejects an empty export format list at build time', function () {
    $grid = Grid::make('items')
        ->query(fn () => ExportItem::query())
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')])
        ->exportable([]);

    expect(fn () => $grid->assertValid())
        ->toThrow(InvalidArgumentException::class, 'empty format list');
});

// ---- Config serialization -------------------------------------------------------------------

it('serializes layout.export with the enabled formats, and omits it when not declared', function () {
    $component = new ServerGridComponent;
    $config = app(ConfigSerializer::class)->serialize($component->gridDefinition('items'));

    expect($config['layout']['export'])->toBe(['formats' => ['csv', 'xlsx', 'pdf']]);

    $off = new ServerGridComponent;
    $off->exportOff = true;
    $config = app(ConfigSerializer::class)->serialize($off->gridDefinition('items'));

    expect($config['layout'])->not->toHaveKey('export');
});

// ---- RPC gating (fail-closed) ---------------------------------------------------------------

it('refuses gridExport when the grid declares no exportable()', function () {
    $component = new ServerGridComponent;
    $component->exportOff = true;

    $component->gridExport('items', 'csv');
})->throws(InvalidArgumentException::class, 'not exportable');

it('refuses a format the definition does not enable, even though it is registered', function () {
    $component = new ServerGridComponent;
    $component->formats = ['csv'];

    $component->gridExport('items', 'pdf');
})->throws(InvalidArgumentException::class, 'does not offer the [pdf] export format');

it('enforces the grid authorize gate on export', function () {
    $component = new ServerGridComponent;
    $component->deny = true;

    $component->gridExport('items', 'csv');
})->throws(AuthorizationException::class, 'Denied.');

it('downloads through the Livewire request path', function () {
    Livewire::test(ServerGridComponent::class)
        ->call('gridExport', 'items', 'csv', [])
        ->assertFileDownloaded();
});

// ---- CSV content ------------------------------------------------------------------------------

it('exports CSV with a BOM, painted values, raw numerics and an honest totals row', function () {
    $csv = exportBytes(new ServerGridComponent, 'csv');

    expect(str_starts_with($csv, "\xEF\xBB\xBF"))->toBeTrue();

    $rows = csvRows($csv);

    // Header: visible columns minus ->exportable(false) note and the HiddenColumn secret.
    expect($rows[0])->toBe(['#', 'Item', 'Code', 'Type', 'Qty', 'Rate', 'Active', 'Booked', 'Status']);

    // Default sort (name asc): Anvil, Bolt, Cable "A". Values are what the grid PAINTS —
    // select labels, Yes/No, the d-m-Y date pattern, stripped html — with numerics raw.
    expect($rows[1])->toBe(['1', 'Anvil', '', 'Service', '4', '100.00', 'No', '', 'Off']);
    expect($rows[2])->toBe(['2', 'Bolt', '00123', 'Goods', '10', '12.50', 'Yes', '15-01-2026', 'Live']);
    expect($rows[3])->toBe(['3', 'Cable "A"', '007', 'Goods', '6', '3.25', 'Yes', '01-02-2026', 'Live']);

    // Totals: label in the first unsummed cell, sums under their columns.
    expect($rows[4])->toBe(['Total', '', '', '', '20', '115.75', '', '', '']);
});

it('exports the CURRENT view: search, filters and sort narrow the file exactly like gridFetch', function () {
    $component = new ServerGridComponent;

    $searched = csvRows(exportBytes($component, 'csv', ['search' => 'bolt']));
    expect($searched)->toHaveCount(3); // header + Bolt + totals
    expect($searched[1][1])->toBe('Bolt');
    expect($searched[2][4])->toBe('10'); // totals sum only the filtered rows

    $filtered = csvRows(exportBytes($component, 'csv', ['filters' => ['type' => 'service']]));
    expect($filtered)->toHaveCount(3);
    expect($filtered[1][1])->toBe('Anvil');

    $sorted = csvRows(exportBytes($component, 'csv', ['sort' => 'qty', 'dir' => 'desc']));
    expect(array_column(array_slice($sorted, 1, 3), 1))->toBe(['Bolt', 'Cable "A"', 'Anvil']);
});

it('caps exported rows at the declared limit and totals only what is in the file', function () {
    $component = new ServerGridComponent;
    $component->limit = 2;

    $rows = csvRows(exportBytes($component, 'csv'));

    expect($rows)->toHaveCount(4); // header + 2 rows + totals
    expect(array_column(array_slice($rows, 1, 2), 1))->toBe(['Anvil', 'Bolt']);
    // Totals stay RAW numerics (112.5, not the number-format's '112.50') — the file's
    // spreadsheet consumer re-formats; only the PDF paints formatted totals.
    expect(end($rows))->toBe(['Total', '', '', '', '14', '112.5', '', '', '']);
});

// ---- XLSX content -----------------------------------------------------------------------------

it('exports a valid XLSX package with typed cells and bold header/totals', function () {
    $bytes = exportBytes(new ServerGridComponent, 'xlsx');

    $path = tempnam(sys_get_temp_dir(), 'lgrid-test');
    file_put_contents($path, $bytes);
    $zip = new ZipArchive;
    expect($zip->open($path))->toBeTrue();

    foreach (['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml'] as $part) {
        expect($zip->getFromName($part))->not->toBeFalse();
    }

    $workbook = (string) $zip->getFromName('xl/workbook.xml');
    expect($workbook)->toContain('name="item-register"');

    $sheet = (string) $zip->getFromName('xl/worksheets/sheet1.xml');
    $zip->close();
    @unlink($path);

    // Bold header row with inline-string labels.
    expect($sheet)->toContain('<row r="1"><c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">#</t></is></c>');

    // Numeric columns are REAL number cells; the leading-zero code stays a string cell.
    expect($sheet)->toContain('<v>10</v>');       // qty int
    expect($sheet)->toContain('<v>12.50</v>');    // fixed-scale decimal string rides as a number
    expect($sheet)->toContain('>00123</t>');      // code keeps its zeros (inline string)
    expect($sheet)->not->toContain('<v>00123</v>');

    // XML-escaped text and the bold totals row summing the register.
    expect($sheet)->toContain('Cable &quot;A&quot;');
    expect($sheet)->toContain('<t xml:space="preserve">Total</t>');
    expect($sheet)->toContain('<v>115.75</v>');
});

// ---- PDF content ------------------------------------------------------------------------------

/** Inflate every content stream of a generated PDF (they are Flate-compressed when zlib exists). */
function pdfText(string $pdf): string
{
    preg_match_all("#stream\n(.*?)\nendstream#s", $pdf, $matches);
    $text = '';
    foreach ($matches[1] as $stream) {
        $inflated = @gzuncompress($stream);
        $text .= $inflated === false ? $stream : $inflated;
    }

    return $text;
}

it('exports a structurally valid PDF with formatted, painted values', function () {
    $pdf = exportBytes(new ServerGridComponent, 'pdf');

    expect(str_starts_with($pdf, '%PDF-1.4'))->toBeTrue();
    expect(str_ends_with($pdf, "%%EOF\n"))->toBeTrue();

    // The xref table must sit exactly where startxref claims…
    preg_match('/startxref\n(\d+)\n%%EOF\n$/', $pdf, $matches);
    expect($matches)->not->toBeEmpty();
    expect(substr($pdf, (int) $matches[1], 4))->toBe('xref');

    // …and every xref entry must point at the byte where its object actually begins —
    // offset drift is THE way a hand-rolled PDF writer breaks.
    preg_match('/xref\n0 (\d+)\n/', $pdf, $head);
    // Lines: 'xref', '0 N', the object-0 free entry, then one in-use entry per object.
    $entries = array_slice(explode("\n", substr($pdf, (int) $matches[1])), 3, (int) $head[1] - 1);
    foreach ($entries as $id => $entry) {
        $offset = (int) substr($entry, 0, 10);
        expect(substr($pdf, $offset, strlen(($id + 1).' 0 obj')))->toBe(($id + 1).' 0 obj');
    }

    $text = pdfText($pdf);

    expect($text)->toContain('(Bolt)');
    expect($text)->toContain('(Goods)');          // the select label, not the id
    expect($text)->toContain('(15-01-2026)');     // the grid's date display pattern
    expect($text)->toContain('(Total)');
    expect($text)->toContain('(115.75)');         // rate total through the aggregate's number format
    expect($text)->toContain('(Page 1)');
    expect($text)->not->toContain('(n1)');        // ->exportable(false) column stays out
});

it('paginates the PDF and repeats the header row on every page', function () {
    for ($i = 1; $i <= 120; $i++) {
        ExportItem::create(['name' => sprintf('Part %03d', $i), 'type' => 'goods', 'qty' => 1, 'rate' => '1.00', 'active' => true]);
    }

    $pdf = exportBytes(new ServerGridComponent, 'pdf');

    preg_match_all('#/Type /Page[^s]#', $pdf, $pages);
    expect(count($pages[0]))->toBeGreaterThan(1);

    $text = pdfText($pdf);
    preg_match_all('/\(Page \d+\)/', $text, $numbers);
    expect(count($numbers[0]))->toBe(count($pages[0]));

    // The bold header labels repeat per page.
    expect(substr_count($text, '(Item)'))->toBe(count($pages[0]));
});

// ---- Extension seam ---------------------------------------------------------------------------

it('lets an app register a custom exporter and grids enable it by name', function () {
    app(ExporterRegistry::class)->register('tsv', new class implements Exporter
    {
        public function extension(): string
        {
            return 'tsv';
        }

        public function mimeType(): string
        {
            return 'text/tab-separated-values';
        }

        public function write(ExportData $data): void
        {
            echo implode("\t", array_map(fn (array $c): string => $c['label'], $data->columns))."\n";
            foreach ($data->rows as $cells) {
                echo implode("\t", array_map(strval(...), $cells))."\n";
            }
        }
    });

    $component = new ServerGridComponent;
    $component->formats = ['tsv'];

    $component->gridDefinition('items')->assertValid(); // the registry now knows 'tsv'

    $tsv = exportBytes($component, 'tsv');
    expect($tsv)->toContain("Bolt\t00123\tGoods\t10\t12.50");
});
