<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Contracts\View\View;
use LaraGrid\Aggregate;
use LaraGrid\Columns\CheckboxColumn;
use LaraGrid\Columns\ComputedColumn;
use LaraGrid\Columns\DateColumn;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\HiddenColumn;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\SelectColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Filters\SelectFilter;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: A server-side (->query()) host with ->exportable() declared, one column per export
 *       value family, footer sums, search + a filter — the gridExport RPC's full test rig.
 *
 * Why:  Exports must prove themselves through the real pipeline: the whitelisted narrowing,
 *       picker-label resolution, html stripping, the column opt-out, raw-vs-formatted value
 *       families, and the fail-closed authorize gate ($deny flips it to a refusal).
 *
 * When: tests/Feature/ExportTest.
 */
class ServerGridComponent extends Component
{
    use WithLaraGrid;

    /** Flips the grid's authorize() gate to a denial (fail-closed path). */
    public bool $deny = false;

    /** Export formats the grid offers (tests narrow this per scenario). */
    public array $formats = ['csv', 'xlsx', 'pdf'];

    /** Per-grid export row cap override, null = config default. */
    public ?int $limit = null;

    /** Drops the ->exportable() declaration entirely (the not-exportable RPC gate). */
    public bool $exportOff = false;

    /**
     * @return array<string, Grid>
     */
    protected function grids(): array
    {
        return [
            'items' => Grid::make('items')
                ->query(fn () => ExportItem::query())
                ->authorize(function (): bool {
                    if ($this->deny) {
                        throw new AuthorizationException('Denied.');
                    }

                    return true;
                })
                ->paginate(2, [2, 5])
                ->defaultSort('name')
                ->searchable(['name'])
                ->filters([
                    SelectFilter::make('type')->label('Type')
                        ->options(['goods' => 'Goods', 'service' => 'Service']),
                ])
                ->exportable($this->exportOff ? false : $this->formats, fileName: 'item-register', limit: $this->limit)
                ->columns([
                    SerialColumn::make(),
                    TextColumn::make('name')->label('Item')->sortable()->searchable()->grow(),
                    TextColumn::make('code')->width(80),
                    SelectColumn::make('type')->options(['goods' => 'Goods', 'service' => 'Service'])->width(90),
                    IntegerColumn::make('qty')->sortable()->width(70),
                    DecimalColumn::make('rate')->scale(2)->width(90),
                    CheckboxColumn::make('active')->width(60),
                    DateColumn::make('booked_on')->label('Booked')->width(100),
                    ComputedColumn::make('status')->html()
                        ->state(fn (array $row): string => '<span class="badge">'.($row['active'] ? 'Live' : 'Off').'</span>'),
                    TextColumn::make('note')->exportable(false),
                    HiddenColumn::make('secret'),
                ])
                ->footer([
                    Aggregate::sum('qty'),
                    Aggregate::sum('rate')->format('number', ['scale' => 2]),
                ]),
        ];
    }

    public function render(): View
    {
        return view('laragrid-tests::server-grid');
    }
}
