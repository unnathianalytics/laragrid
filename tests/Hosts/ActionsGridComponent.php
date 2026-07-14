<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Contracts\View\View;
use Illuminate\Validation\ValidationException;
use LaraGrid\Actions\Action;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: An editable-grid host declaring all three action scopes, for gridAction RPC tests.
 *
 * Why:  The action pipeline (grid gate → action gate → row re-resolution → visibility
 *       re-check → closure) only proves itself through the real Livewire request path.
 *
 * When: tests/Feature/ActionsTest.
 */
class ActionsGridComponent extends Component
{
    /** @var list<array<string, mixed>> */
    public array $lines = [
        ['_k' => 'a', 'name' => 'Alpha', 'locked' => false],
        ['_k' => 'b', 'name' => 'Beta', 'locked' => true],
    ];

    public bool $pinged = false;

    use WithLaraGrid;

    /**
     * @return array<string, Grid>
     */
    protected function grids(): array
    {
        return [
            'items' => Grid::make('items')
                ->editable()
                ->rowsFrom('lines')
                ->authorize(fn (): bool => true)
                ->columns([
                    SerialColumn::make(),
                    TextColumn::make('name'),
                ])
                ->actions([
                    Action::make('edit')->icon('✎')
                        ->url(fn (array $row): ?string => $row['locked'] ? null : '/items/'.$row['_k'].'/edit'),
                    Action::make('zap')->confirm('Zap this row?')
                        ->visible(fn (array $row): bool => ! $row['locked'])
                        ->call(function (array $row): void {
                            foreach ($this->lines as $i => $line) {
                                if ($line['_k'] === $row['_k']) {
                                    $this->lines[$i]['name'] = 'ZAPPED';
                                }
                            }
                        }),
                    Action::make('guarded')
                        ->authorize(fn () => throw new AuthorizationException('Denied.'))
                        ->call(fn (array $row): mixed => null),
                    Action::make('refuse')
                        ->call(fn (array $row) => throw ValidationException::withMessages(['name' => 'Cannot do that.'])),
                ])
                ->bulkActions([
                    Action::make('purge')->call(function (array $keys): void {
                        $this->lines = array_values(array_filter(
                            $this->lines,
                            fn (array $line): bool => ! in_array($line['_k'], $keys, true),
                        ));
                    }),
                ])
                ->toolbarActions([
                    Action::make('ping')->call(function (): void {
                        $this->pinged = true;
                    }),
                    Action::make('create')->label('New Item')->url(fn (): string => '/items/create'),
                ]),
        ];
    }

    public function render(): View
    {
        return view('laragrid-tests::actions-grid');
    }
}
