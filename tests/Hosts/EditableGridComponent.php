<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Contracts\View\View;
use LaraGrid\Columns\SelectColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: A minimal editable-grid Livewire host for trait/op-protocol feature tests —
 *       defaultRows seeding, panel-done dispatch, gridOps round trips.
 *
 * Why:  Editable behavior (fail-closed authorize, rowsFrom binding, op application through
 *       the real Livewire request path) is only honest when exercised on a real component.
 *
 * When: tests/Feature — Livewire::test(EditableGridComponent::class).
 */
class EditableGridComponent extends Component
{
    /** @var list<array<string, mixed>> */
    public array $lines = [];

    use WithLaraGrid;

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
                ->minRows(1)
                ->defaultRows(2)
                ->newRowUsing(fn (): array => ['dc' => 'D'])
                ->columns([
                    SerialColumn::make(),
                    SelectColumn::make('dc')->options(['D' => 'Dr', 'C' => 'Cr']),
                    TextColumn::make('narration')->maxLength(10),
                ]),
        ];
    }

    /** Test hook: the panel-resume dispatch. */
    public function closePanel(): void
    {
        $this->gridPanelDone('lines');
    }

    public function render(): View
    {
        return view('laragrid-tests::editable-grid');
    }
}
