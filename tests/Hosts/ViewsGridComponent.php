<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Contracts\View\View;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Filters\SelectFilter;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: A server-side (->query()) host with ->savedViews() declared — the gridViews /
 *       gridViewSave / gridViewDelete RPCs' test rig.
 *
 * Why:  Saved views must prove themselves fail-closed: the authorize gate ($deny), the
 *       declaration gate ($viewsOff drops savedViews()), per-user scoping, and the state
 *       sanitizer validating against THESE declared columns/filters/per-page options.
 *
 * When: tests/Feature/SavedViewsTest.
 */
class ViewsGridComponent extends Component
{
    use WithLaraGrid;

    /** Flips the grid's authorize() gate to a denial (fail-closed path). */
    public bool $deny = false;

    /** Drops the ->savedViews() declaration entirely (the not-declared RPC gate). */
    public bool $viewsOff = false;

    /**
     * @return array<string, Grid>
     */
    protected function grids(): array
    {
        $grid = Grid::make('items')
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
            ->columns([
                SerialColumn::make(),
                TextColumn::make('name')->label('Item')->sortable()->searchable()->grow(),
                TextColumn::make('type')->width(90),
                IntegerColumn::make('qty')->sortable()->width(70),
            ]);

        if (! $this->viewsOff) {
            $grid->savedViews();
        }

        return ['items' => $grid];
    }

    public function render(): View
    {
        return view('laragrid-tests::views-grid');
    }
}
