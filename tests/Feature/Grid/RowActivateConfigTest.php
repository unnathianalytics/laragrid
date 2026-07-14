<?php

declare(strict_types=1);

use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Support\RowSerializer;

/**
 * What: Locks the row-activation serialization contract — `layout.rowActivate` is advertised only
 *       when a resolver is declared (whenFilled discipline), each row bakes its resolver's URL onto
 *       `_activateUrl`, a null return leaves that row inert, and an editable grid never activates.
 *
 * Why:  The client engine (RowActivator/KeyboardManager) keys row activation entirely off these two
 *       serialized signals; if the layout flag or the per-row URL drifts, Enter/double-click silently
 *       stops working (or leaks onto rows/grids that must not activate). Pinning both here keeps the
 *       declarative bridge honest without a browser round-trip.
 *
 * When: Fast feature coverage.
 */
it('emits layout.rowActivate only when a resolver is declared (whenFilled discipline)', function () {
    $serializer = new ConfigSerializer;

    $plain = $serializer->serialize(Grid::make('s')->columns([TextColumn::make('a')]), []);
    $active = $serializer->serialize(
        Grid::make('s')->columns([TextColumn::make('a')])
            ->rowActivate(fn (array $row): string => '/x/'.$row['a']),
        [],
    );

    // Absent unless declared so committed golden configs never rot.
    expect($plain['layout'])->not->toHaveKey('rowActivate')
        ->and($active['layout']['rowActivate'])->toBeTrue();
});

it('bakes each row _activateUrl from the resolver', function () {
    $grid = Grid::make('s')
        ->columns([TextColumn::make('id'), TextColumn::make('name')])
        ->rowActivate(fn (array $row): string => '/items/'.$row['id'].'/edit');

    $rows = (new RowSerializer)->serializeMany($grid, [
        ['id' => 7, 'name' => 'Bolt'],
        ['id' => 9, 'name' => 'Nut'],
    ]);

    expect($rows[0]['_activateUrl'])->toBe('/items/7/edit')
        ->and($rows[1]['_activateUrl'])->toBe('/items/9/edit');
});

it('omits _activateUrl for a row whose resolver returns null (inert row)', function () {
    // A per-row gate (e.g. no permission / a protected row) returns null → that row is not activatable.
    $grid = Grid::make('s')
        ->columns([TextColumn::make('id'), TextColumn::make('locked')])
        ->rowActivate(fn (array $row): ?string => ($row['locked'] ?? false) ? null : '/x/'.$row['id']);

    $rows = (new RowSerializer)->serializeMany($grid, [
        ['id' => 1, 'locked' => false],
        ['id' => 2, 'locked' => true],
    ]);

    expect($rows[0]['_activateUrl'])->toBe('/x/1')
        ->and($rows[1])->not->toHaveKey('_activateUrl');
});

it('never bakes _activateUrl on an editable grid even if a resolver is set', function () {
    // Editable grids reserve Enter/double-click for the editor; activation must not leak in.
    $grid = Grid::make('s')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn () => true)
        ->columns([TextColumn::make('id')->required()])
        ->rowActivate(fn (array $row): string => '/x/'.$row['id']);

    $rows = (new RowSerializer)->serializeMany($grid, [
        ['_k' => 'r1', 'id' => 1],
    ]);

    expect($rows[0])->not->toHaveKey('_activateUrl');
});
