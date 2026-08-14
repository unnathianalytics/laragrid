<?php

declare(strict_types=1);

use Illuminate\Auth\Access\AuthorizationException;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Export\ExportBuilder;
use LaraGrid\Export\ExportData;
use LaraGrid\Export\Exporter;
use LaraGrid\Export\ExporterRegistry;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\InMemoryExportGridComponent;
use Livewire\Livewire;

/** Capture an in-memory report export's streamed bytes. */
function memoryExportBytes(InMemoryExportGridComponent $component, string $format, array $state = []): string
{
    $response = $component->gridExport('report', $format, $state);

    ob_start();
    $response->sendContent();

    return (string) ob_get_clean();
}

/** @return list<list<string>> */
function memoryCsvRows(string $csv): array
{
    $csv = (string) preg_replace('/^\xEF\xBB\xBF/', '', $csv);

    return array_map(
        fn (string $line): array => str_getcsv($line, ',', '"', ''),
        array_values(array_filter(explode("\n", trim($csv)))),
    );
}

it('validates a readonly in-memory export source without switching display mode', function () {
    $component = new InMemoryExportGridComponent;
    $grid = $component->gridDefinition('report');

    $grid->assertValid();

    expect($grid->hasExportRowResolver())->toBeTrue()
        ->and($grid->hasServerExportSource())->toBeTrue()
        ->and($grid->isServerSide())->toBeFalse();

    $config = app(ConfigSerializer::class)->serialize($grid, $component->rows);

    expect($config['layout']['mode'])->toBe('inline')
        ->and($config['layout']['serverSide'])->toBeFalse()
        ->and($config['layout']['paginate'])->toBeNull()
        ->and($config['layout']['export'])->toBe(['formats' => ['csv', 'xlsx', 'pdf']])
        ->and($config['rows'][0]['name'])->toBe('CLIENT TAMPERED ROW');
});

it('fails closed when an exportRows grid has no authorization gate', function () {
    $grid = Grid::make('report')
        ->exportRows(fn (array $state): iterable => [])
        ->exportable()
        ->columns([TextColumn::make('name')]);

    expect(fn () => $grid->assertValid())
        ->toThrow(InvalidArgumentException::class, 'exportRows() but no authorize()');
});

it('does not permit exportRows on editable grids', function () {
    $grid = Grid::make('report')
        ->editable()
        ->rowsFrom('rows')
        ->authorize(fn (): bool => true)
        ->exportRows(fn (array $state): iterable => [])
        ->exportable()
        ->columns([TextColumn::make('name')]);

    expect(fn () => $grid->assertValid())
        ->toThrow(InvalidArgumentException::class, 'cannot be both editable() and exportRows()');
});

it('reauthorizes every export and never invokes the resolver after a denial', function () {
    $component = new InMemoryExportGridComponent;

    $component->gridExport('report', 'csv');
    $component->gridExport('report', 'csv');

    expect($component->authorizationCalls)->toBe(2)
        ->and($component->resolverCalls)->toBe(2);

    $component->deny = true;

    expect(fn () => $component->gridExport('report', 'csv'))
        ->toThrow(AuthorizationException::class, 'Denied report export.');

    expect($component->authorizationCalls)->toBe(3)
        ->and($component->resolverCalls)->toBe(2);
});

it('exports trusted array rows with shared columns, computeds, numerics, exclusions and totals', function () {
    $component = new InMemoryExportGridComponent;
    $rows = memoryCsvRows(memoryExportBytes($component, 'csv'));

    expect($rows[0])->toBe(['#', 'Item', 'Type', 'Qty', 'Rate', 'Active', 'Status'])
        ->and($rows[1])->toBe(['1', 'Alpha', 'goods', '2', '10.25', 'Yes', 'Live'])
        ->and($rows[2])->toBe(['2', 'Beta', 'service', '3', '2.50', 'No', 'Off'])
        ->and($rows[3])->toBe(['3', 'Gamma', 'goods', '4', '1.25', 'Yes', 'Live'])
        ->and($rows[4])->toBe(['Total', '', '', '9', '14', '', ''])
        ->and($component->rows[0]['name'])->toBe('CLIENT TAMPERED ROW')
        ->and(implode("\n", array_map(fn (array $row): string => implode(',', $row), $rows)))
        ->not->toContain('CLIENT TAMPERED ROW')
        ->not->toContain('private-a')
        ->not->toContain('s-a');
});

it('streams generator and Arrayable rows while stopping exactly at the row cap', function () {
    $component = new InMemoryExportGridComponent;
    $component->generator = true;
    $component->arrayable = true;
    $component->limit = 2;

    $rows = memoryCsvRows(memoryExportBytes($component, 'csv'));

    expect($component->yieldedRows)->toBe(2)
        ->and($rows)->toHaveCount(4)
        ->and(array_column(array_slice($rows, 1, 2), 1))->toBe(['Alpha', 'Beta'])
        ->and(end($rows))->toBe(['Total', '', '', '5', '12.75', '', '']);
});

it('supports CSV XLSX and PDF from the in-memory resolver source', function () {
    $component = new InMemoryExportGridComponent;

    $csv = memoryExportBytes($component, 'csv');
    $xlsx = memoryExportBytes($component, 'xlsx');
    $pdf = memoryExportBytes($component, 'pdf');

    expect(str_starts_with($csv, "\xEF\xBB\xBF"))->toBeTrue()
        ->and(str_starts_with($xlsx, 'PK'))->toBeTrue()
        ->and(str_starts_with($pdf, '%PDF-1.4'))->toBeTrue()
        ->and(str_ends_with($pdf, "%%EOF\n"))->toBeTrue();
});

it('routes resolver rows through app-registered exporters', function () {
    app(ExporterRegistry::class)->register('lines', new class implements Exporter
    {
        public function extension(): string
        {
            return 'txt';
        }

        public function mimeType(): string
        {
            return 'text/plain';
        }

        public function write(ExportData $data): void
        {
            foreach ($data->rows as $row) {
                echo implode('|', array_map(strval(...), $row))."\n";
            }
        }
    });

    $component = new InMemoryExportGridComponent;
    $component->formats = ['lines'];

    expect(memoryExportBytes($component, 'lines'))
        ->toContain('1|Alpha|goods|2|10.25|Yes|Live');
});

it('passes only normalized sortable search and declared-filter state to the resolver', function () {
    $component = new InMemoryExportGridComponent;
    $longSearch = str_repeat('x', 250);

    $component->gridExport('report', 'csv', [
        'sort' => 'note', // declared, but not sortable
        'dir' => 'desc',
        'search' => $longSearch,
        'filters' => ['type' => 'goods', 'unknown' => 'injected'],
        'rows' => [['name' => 'CLIENT INJECTION']],
        'perPage' => 999999,
        'unknown' => 'discard me',
    ]);

    expect($component->receivedState)->toBe([
        'sort' => null,
        'dir' => 'desc',
        'search' => str_repeat('x', 200),
        'filters' => ['type' => 'goods'],
    ]);

    $component->gridExport('report', 'csv', [
        'sort' => 'qty',
        'dir' => 'sideways',
        'search' => ['malformed'],
        'filters' => ['type' => 'not-an-option'],
    ]);

    expect($component->receivedState)->toBe([
        'sort' => 'qty',
        'dir' => 'asc',
        'search' => '',
        'filters' => [],
    ]);
});

it('rejects a resolver return value that is not iterable', function () {
    $grid = Grid::make('report')
        ->authorize(fn (): bool => true)
        ->exportRows(fn (array $state): string => 'not iterable')
        ->exportable(['csv'])
        ->columns([TextColumn::make('name')]);

    expect(fn () => app(ExportBuilder::class)->build($grid, []))
        ->toThrow(InvalidArgumentException::class, 'exportRows() must return an iterable');
});

it('keeps query-only RPCs unavailable for an exportRows-backed display grid', function () {
    $component = new InMemoryExportGridComponent;

    expect(fn () => $component->gridFetch('report', []))
        ->toThrow(InvalidArgumentException::class, 'gridFetch is unavailable');
});

it('downloads resolver-backed exports through Livewire', function () {
    Livewire::test(InMemoryExportGridComponent::class)
        ->call('gridExport', 'report', 'csv', [])
        ->assertFileDownloaded();
});
