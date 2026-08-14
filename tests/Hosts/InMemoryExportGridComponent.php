<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Contracts\Support\Arrayable;
use Illuminate\Contracts\View\View;
use LaraGrid\Aggregate;
use LaraGrid\Columns\CheckboxColumn;
use LaraGrid\Columns\ComputedColumn;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\HiddenColumn;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Filters\SelectFilter;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/** @implements Arrayable<string, mixed> */
final class ExportRowDto implements Arrayable
{
    /** @param array<string, mixed> $attributes */
    public function __construct(private readonly array $attributes) {}

    /** @return array<string, mixed> */
    public function toArray(): array
    {
        return $this->attributes;
    }
}

/** Test host for a display-in-memory grid with an independent trusted export source. */
class InMemoryExportGridComponent extends Component
{
    use WithLaraGrid;

    /** Browser-visible rows are intentionally unrelated to the trusted export rows. */
    public array $rows = [
        ['_k' => 'client', 'name' => 'CLIENT TAMPERED ROW', 'qty' => 999, 'rate' => '999.99'],
    ];

    public bool $deny = false;

    public bool $generator = false;

    public bool $arrayable = false;

    public int $authorizationCalls = 0;

    public int $resolverCalls = 0;

    public int $yieldedRows = 0;

    /** @var array<string, mixed> */
    public array $receivedState = [];

    public ?int $limit = null;

    /** @var list<string> */
    public array $formats = ['csv', 'xlsx', 'pdf'];

    /** @return array<string, Grid> */
    protected function grids(): array
    {
        return [
            'report' => Grid::make('report')
                ->authorize(function (): bool {
                    $this->authorizationCalls++;
                    if ($this->deny) {
                        throw new AuthorizationException('Denied report export.');
                    }

                    return true;
                })
                ->exportRows(function (array $state): iterable {
                    $this->resolverCalls++;
                    $this->receivedState = $state;

                    $rows = $this->trustedRows();

                    return $this->generator ? $this->generateRows($rows) : $this->convertRows($rows);
                })
                ->exportable($this->formats, fileName: 'memory-report', limit: $this->limit)
                ->filters([
                    SelectFilter::make('type')->options(['goods' => 'Goods', 'service' => 'Service']),
                ])
                ->columns([
                    SerialColumn::make(),
                    TextColumn::make('name')->label('Item')->sortable(),
                    TextColumn::make('type'),
                    IntegerColumn::make('qty')->sortable(),
                    DecimalColumn::make('rate')->scale(2),
                    CheckboxColumn::make('active'),
                    ComputedColumn::make('status')->html()
                        ->state(fn (array $row): string => '<b>'.(($row['active'] ?? false) ? 'Live' : 'Off').'</b>'),
                    TextColumn::make('note')->exportable(false),
                    HiddenColumn::make('secret'),
                ])
                ->footer([
                    Aggregate::sum('qty'),
                    Aggregate::sum('rate')->format('number', ['scale' => 2]),
                ]),
        ];
    }

    /** @return list<array<string, mixed>> */
    private function trustedRows(): array
    {
        return [
            ['name' => 'Alpha', 'type' => 'goods', 'qty' => 2, 'rate' => '10.25', 'active' => true, 'note' => 'private-a', 'secret' => 's-a'],
            ['name' => 'Beta', 'type' => 'service', 'qty' => 3, 'rate' => '2.50', 'active' => false, 'note' => 'private-b', 'secret' => 's-b'],
            ['name' => 'Gamma', 'type' => 'goods', 'qty' => 4, 'rate' => '1.25', 'active' => true, 'note' => 'private-c', 'secret' => 's-c'],
        ];
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return iterable<int, array<string, mixed>|ExportRowDto>
     */
    private function generateRows(array $rows): iterable
    {
        foreach ($rows as $row) {
            $this->yieldedRows++;
            yield $this->arrayable ? new ExportRowDto($row) : $row;
        }
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     * @return list<array<string, mixed>|ExportRowDto>
     */
    private function convertRows(array $rows): array
    {
        if (! $this->arrayable) {
            return $rows;
        }

        return array_map(fn (array $row): ExportRowDto => new ExportRowDto($row), $rows);
    }

    public function render(): View
    {
        return view('laragrid-tests::in-memory-export-grid');
    }
}
