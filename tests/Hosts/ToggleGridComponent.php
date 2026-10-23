<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Contracts\View\View;
use LaraGrid\Aggregate;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: An editable-grid host whose mount sits under an @if, plus a second DISPLAY grid bound
 *       through rowsFrom() — the rig for the "skip the discarded config payload" contract.
 *
 * Why:  The shell payload must only ever go to a grid the browser already mounted: a grid
 *       that first appears after an update (the @if flips) needs the full payload, a grid
 *       that disappears and comes back needs it again, and a rowsFrom()-bound display grid
 *       must be reseedable through gridReseedRows like an editable one.
 *
 * When: tests/Feature/ShellPayloadTest.
 */
class ToggleGridComponent extends Component
{
    use WithLaraGrid;

    public bool $show = false;

    /** @var list<array<string, mixed>> */
    public array $lines = [];

    /** @var list<array<string, mixed>> */
    public array $taxes = [
        ['_k' => 'a', 'name' => 'Alpha', 'rate' => '10.00'],
        ['_k' => 'b', 'name' => 'Beta', 'rate' => '5.50'],
    ];

    public function mount(): void
    {
        $this->lines = $this->gridMountRows('lines');
    }

    /**
     * @return array<string, Grid>
     */
    protected function grids(): array
    {
        return [
            'lines' => Grid::make('lines')
                ->editable()
                ->rowsFrom('lines')
                ->authorize(fn (): bool => true)
                ->defaultRows(2)
                ->columns([
                    TextColumn::make('narration'),
                    DecimalColumn::make('amount')->scale(2),
                ])
                ->footer([Aggregate::sum('amount')]),
            'taxes' => Grid::make('taxes')
                ->rowsFrom('taxes')
                ->columns([
                    TextColumn::make('name'),
                    DecimalColumn::make('rate')->scale(2),
                ])
                ->footer([Aggregate::sum('rate')]),
        ];
    }

    public function render(): View
    {
        return view('laragrid-tests::toggle-grid');
    }
}
