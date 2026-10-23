<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Contracts\View\View;
use LaraGrid\Columns\Column;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: An editable host whose column set is injected by the test — the rig for the
 *       row-validation equivalence matrix (gridRows / gridRestoreDraft must report exactly
 *       what the old one-Validator-per-cell loop reported, for any rule mix).
 *
 * Why:  The equivalence claim has to hold for rules a consumer might declare, not just the
 *       package's own; injecting the columns lets one test sweep closures, exclude rules,
 *       rule objects and cross-field string rules without a host class per case.
 *
 * When: tests/Feature/RowValidationTest — instantiated directly (no Livewire request), the
 *       column set handed in before the first gridDefinition() call.
 */
class RuleMatrixGridComponent extends Component
{
    use WithLaraGrid;

    /** @var list<array<string, mixed>> */
    public array $lines = [];

    /** @var list<Column> */
    private array $matrixColumns = [];

    /**
     * @param  list<Column>  $columns
     */
    public function useColumns(array $columns): static
    {
        $this->matrixColumns = $columns;

        return $this;
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
                ->columns($this->matrixColumns),
        ];
    }

    public function render(): View
    {
        return view('laragrid-tests::editable-grid');
    }
}
