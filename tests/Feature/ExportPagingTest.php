<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use LaraGrid\Aggregate;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Export\ExportBuilder;
use LaraGrid\Export\Exporters\PdfExporter;
use LaraGrid\Export\Exporters\XlsxExporter;
use LaraGrid\Grid;
use LaraGrid\Tests\Hosts\ExportItem;

/**
 * What: How a query-backed export pages through its rows (performance plan P7): keyset paging
 *       (lazyById) when the order is the primary key or absent, LIMIT/OFFSET with a key
 *       tie-break for any other order or an unsafe query shape, and in every case each row
 *       exactly once across chunk boundaries. Also the XLSX and PDF writers over a multi-chunk,
 *       multi-page stream: the sheet's temp file is removed, and the PDF's xref still points at
 *       every object although the pages are written before the catalog.
 */
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

    // 130 rows in three type buckets (heavy sort ties), names in insertion (id) order.
    foreach (range(1, 130) as $i) {
        ExportItem::create(['name' => sprintf('Row %03d', $i), 'type' => ['c', 'a', 'b'][$i % 3], 'qty' => 1]);
    }

    // Floored to 50 by ExportBuilder: chunks of 50, 50 and 30.
    config(['laragrid.export.chunk' => 10]);
});

function pagingGrid(Closure $query): Grid
{
    return Grid::make('paged')
        ->query($query)
        ->authorize(fn (): bool => true)
        ->exportable(['csv', 'xlsx', 'pdf'])
        ->columns([
            IntegerColumn::make('id')->sortable(),
            TextColumn::make('name')->sortable(),
            TextColumn::make('type')->sortable(),
            IntegerColumn::make('qty'),
        ])
        ->footer([Aggregate::sum('qty')]);
}

/** Export through the builder; returns [the exported names in file order, the row SELECTs]. */
function pagedExport(Grid $grid, array $request = []): array
{
    DB::flushQueryLog();
    DB::enableQueryLog();
    $rows = iterator_to_array((new ExportBuilder)->build($grid, $request)->rows, false);
    $sql = array_map(fn (array $entry): string => strtolower($entry['query']), DB::getQueryLog());
    DB::disableQueryLog();

    return [array_column($rows, 1), $sql];
}

/** The 130 names in id order. */
function pagingNames(): array
{
    return array_map(fn (int $i): string => sprintf('Row %03d', $i), range(1, 130));
}

it('pages by key, not by OFFSET, when the export has no sort', function () {
    [$names, $sql] = pagedExport(pagingGrid(fn () => ExportItem::query()));

    expect($names)->toBe(pagingNames());

    expect($sql)->toHaveCount(3);
    foreach ($sql as $query) {
        expect($query)->not->toContain('offset')->toContain('order by "export_items"."id" asc');
    }
    expect($sql[1])->toContain('"export_items"."id" > ?');
    expect($sql[2])->toContain('"export_items"."id" > ?');
});

it('pages by key in descending order when sorted by the key column', function () {
    [$names, $sql] = pagedExport(pagingGrid(fn () => ExportItem::query()), ['sort' => 'id', 'dir' => 'desc']);

    expect($names)->toBe(array_reverse(pagingNames()));

    expect($sql)->toHaveCount(3);
    expect($sql[0])->not->toContain('offset')->toContain('order by "export_items"."id" desc');
    expect($sql[1])->toContain('"export_items"."id" < ?');
});

it('keeps OFFSET paging with a key tie-break for any other sort, and still exports each row once', function () {
    [$names, $sql] = pagedExport(pagingGrid(fn () => ExportItem::query()), ['sort' => 'type']);

    $expected = [];
    foreach (['a', 'b', 'c'] as $type) {
        foreach (range(1, 130) as $i) {
            if (['c', 'a', 'b'][$i % 3] === $type) {
                $expected[] = sprintf('Row %03d', $i);
            }
        }
    }
    expect($names)->toBe($expected);

    expect($sql)->toHaveCount(3);
    expect($sql[2])->toContain('order by "type" asc, "export_items"."id" asc')->toContain('offset');
});

it('keeps OFFSET paging when the key may not come back unambiguous', function (Closure $query) {
    [$names, $sql] = pagedExport(pagingGrid($query));

    expect($names)->toBe(pagingNames());
    expect($sql[1])->toContain('offset');
})->with([
    // A Closure-typed parameter receives the dataset closure itself (Pest does not call it).
    'a join' => fn () => ExportItem::query()
        ->join('export_items as twin', 'twin.id', '=', 'export_items.id')
        ->select('export_items.*'),
    'a select list without the key' => fn () => ExportItem::query()->select('name', 'type', 'qty'),
]);

it('writes a multi-chunk XLSX through a temp sheet file and removes it', function () {
    $leftovers = fn (): int => count(glob(sys_get_temp_dir().DIRECTORY_SEPARATOR.'lg*') ?: []);
    $before = $leftovers();

    $data = (new ExportBuilder)->build(pagingGrid(fn () => ExportItem::query()), []);
    ob_start();
    (new XlsxExporter)->write($data);
    $bytes = (string) ob_get_clean();

    expect($leftovers())->toBe($before);

    $path = (string) tempnam(sys_get_temp_dir(), 'pgt');
    file_put_contents($path, $bytes);
    $zip = new ZipArchive;
    expect($zip->open($path))->toBeTrue();
    $sheet = (string) $zip->getFromName('xl/worksheets/sheet1.xml');
    $zip->close();
    @unlink($path);

    expect(substr_count($sheet, '<row '))->toBe(132); // header + 130 rows + totals
    expect($sheet)->toContain('>Row 130</t>');
    expect($sheet)->toContain('<row r="132"><c r="A132" s="1" t="inlineStr"><is><t xml:space="preserve">Total</t>');
    expect($sheet)->toEndWith('</sheetData></worksheet>');
});

it('streams a multi-page PDF whose xref still points at every object', function () {
    $data = (new ExportBuilder)->build(pagingGrid(fn () => ExportItem::query()), []);
    ob_start();
    (new PdfExporter)->write($data);
    $pdf = (string) ob_get_clean();

    expect(str_starts_with($pdf, '%PDF-1.4'))->toBeTrue();
    preg_match('/startxref\n(\d+)\n%%EOF\n$/', $pdf, $tail);
    expect(substr($pdf, (int) $tail[1], 4))->toBe('xref');

    preg_match('/xref\n0 (\d+)\n/', $pdf, $head);
    $entries = array_slice(explode("\n", substr($pdf, (int) $tail[1])), 3, (int) $head[1] - 1);
    $offsets = [];
    foreach ($entries as $index => $entry) {
        $id = $index + 1;
        $offsets[$id] = (int) substr($entry, 0, 10);
        expect(substr($pdf, $offsets[$id], strlen($id.' 0 obj')))->toBe($id.' 0 obj');
    }

    // Pages first, document objects last: the first page object precedes the catalog.
    expect($offsets[6])->toBeLessThan($offsets[1]);

    preg_match('#/Count (\d+)#', $pdf, $count);
    expect((int) $count[1])->toBeGreaterThan(1);
    expect(count($offsets))->toBe(5 + 2 * (int) $count[1]);

    $text = '';
    preg_match_all("#stream\n(.*?)\nendstream#s", $pdf, $streams);
    foreach ($streams[1] as $stream) {
        $inflated = @gzuncompress($stream);
        $text .= $inflated === false ? $stream : $inflated;
    }
    expect(substr_count($text, '(Row '))->toBe(130);
    expect(substr_count($text, '(Page '))->toBe((int) $count[1]);
});
