<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Contracts\View\View;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

class ZeroRowEditableGridComponent extends Component
{
    /** @var list<array<string, mixed>> */
    public array $lines = [];

    use WithLaraGrid;

    public function mount(): void
    {
        $this->lines = $this->gridMountRows('lines');
    }

    /** @return list<array<string, mixed>> */
    public function logicalLines(): array
    {
        return $this->gridRows('lines');
    }

    /** @return array<string, Grid> */
    protected function grids(): array
    {
        return [
            'lines' => Grid::make('lines')
                ->editable()
                ->rowsFrom('lines')
                ->authorize(fn (): bool => true)
                ->autoAppend()
                ->minRows(0)
                ->newRowUsing(fn (): array => ['qty' => 1])
                ->columns([
                    TextColumn::make('name'),
                    IntegerColumn::make('qty'),
                ]),
        ];
    }

    public function render(): View
    {
        return view('laragrid-tests::zero-row-editable-grid');
    }
}
