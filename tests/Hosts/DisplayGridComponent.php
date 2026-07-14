<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Contracts\View\View;
use LaraGrid\Aggregate;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: A minimal Livewire host exposing one in-memory DISPLAY grid, for trait tests
 *       (gridDefinition resolution, universal reseedGrid) and mount rendering.
 *
 * Why:  The package ships no host of its own; the trait's contract is only exercisable
 *       through a real Livewire component under Testbench.
 *
 * When: tests/Feature — Livewire::test(DisplayGridComponent::class).
 */
class DisplayGridComponent extends Component
{
    /** @var list<array<string, mixed>> */
    public array $rows = [
        ['_k' => 'a', 'name' => 'Alpha', 'rate' => '10.00'],
        ['_k' => 'b', 'name' => 'Beta', 'rate' => '5.50'],
    ];

    use WithLaraGrid;

    /**
     * @return array<string, Grid>
     */
    protected function grids(): array
    {
        return [
            'taxes' => Grid::make('taxes')
                ->columns([
                    SerialColumn::make(),
                    TextColumn::make('name')->grow(),
                    DecimalColumn::make('rate')->scale(2),
                ])
                ->footer([Aggregate::sum('rate')->format('number', ['scale' => 2])])
                ->striped(),
        ];
    }

    /** Test hook: exposes the protected reseedGrid with explicit rows. */
    public function pushRows(): void
    {
        $this->reseedGrid('taxes', [
            ['_k' => 'c', 'name' => 'Gamma', 'rate' => '7.25'],
        ]);
    }

    public function render(): View
    {
        return view('laragrid-tests::display-grid');
    }
}
