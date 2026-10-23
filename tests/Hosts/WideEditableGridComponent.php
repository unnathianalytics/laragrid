<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Contracts\View\View;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: An editable host with eight plain text columns and no validation rules — the shape
 *       of a wide entry grid, used to budget the draft-restore and save paths at volume.
 *
 * Why:  The per-op/per-cell costs the batch context removes only show up at N x C scale;
 *       eight rule-free columns also prove an all-nullable row builds no Validator.
 *
 * When: tests/Feature/OpApplierBatchTest, tests/Feature/RowValidationTest.
 */
class WideEditableGridComponent extends Component
{
    use WithLaraGrid;

    /** @var list<array<string, mixed>> */
    public array $rows = [];

    public function mount(): void
    {
        $this->rows = $this->gridMountRows('wide');
    }

    /**
     * @return array<string, Grid>
     */
    protected function grids(): array
    {
        return [
            'wide' => Grid::make('wide')
                ->editable()
                ->rowsFrom('rows')
                ->authorize(fn (): bool => true)
                ->defaultRows(1)
                ->columns(array_map(fn (int $i): TextColumn => TextColumn::make('c'.$i), range(1, 8))),
        ];
    }

    public function render(): View
    {
        return view('laragrid-tests::wide-editable-grid');
    }
}
