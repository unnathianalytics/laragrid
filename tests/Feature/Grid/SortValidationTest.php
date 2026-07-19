<?php

declare(strict_types=1);

use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;

/**
 * What: Build-time sortable invariants (assertSortableValid) — the PHP half of the
 *       in-memory sort feature, plus the serialized flag the client gates on.
 *
 * Why: The client draws the sort control and binds its handler from ONE predicate
 *      (store.canSort); these asserts catch the misdeclarations that predicate would
 *      otherwise silently swallow: a DB sort target on a grid with no query() (the client
 *      can only sort by the column key), and sortable on an editable grid (row order is
 *      domain-meaningful — the client renders no control, so the declaration would be
 *      dead code). The JS behaviour itself is pinned by tests/js/run-sort-vectors.mjs.
 */
it('accepts plain sortable() on an in-memory display grid and serializes the flag', function () {
    $grid = Grid::make('report')->columns([
        TextColumn::make('account')->sortable(),
        IntegerColumn::make('debit')->sortable(),
    ]);

    $grid->assertValid();

    expect($grid->column('account')->toArray())->toHaveKey('sortable', true)
        ->and($grid->column('debit')->toArray())->toHaveKey('sortable', true);
});

it('rejects a DB sort target on a grid with no query()', function () {
    Grid::make('report')->columns([
        TextColumn::make('account')->sortable('accounts.name'),
    ])->assertValid();
})->throws(InvalidArgumentException::class, 'no query(); an in-memory grid sorts by the column key');

it('rejects sortable columns on an editable grid — row order is domain-meaningful', function () {
    Grid::make('lines')
        ->editable()->rowsFrom('lines')->authorize(fn (): bool => true)
        ->columns([
            TextColumn::make('item')->sortable(),
        ])->assertValid();
})->throws(InvalidArgumentException::class, 'row order is domain-meaningful');

it('still accepts a DB sort target on a server-side query() grid (SQL path unchanged)', function () {
    $grid = Grid::make('list')
        ->query(fn () => null) // resolver presence flips isServerSide(); never invoked here
        ->authorize(fn (): bool => true)
        ->columns([
            TextColumn::make('name')->sortable('items.name'),
        ]);

    $grid->assertValid();

    expect($grid->column('name')->toArray())->toHaveKey('sortable', true);
});

it('accepts defaultSort on a sortable column of a display grid', function () {
    Grid::make('report')
        ->columns([TextColumn::make('account')->sortable()])
        ->defaultSort('account')
        ->assertValid();

    expect(true)->toBeTrue();
});

it('rejects defaultSort on a NON-sortable column — no silent ignore in either mode', function () {
    Grid::make('report')
        ->columns([TextColumn::make('account')->sortable(), TextColumn::make('group')])
        ->defaultSort('group')
        ->assertValid();
})->throws(InvalidArgumentException::class, 'is not ->sortable()');

it('rejects defaultSort on an undeclared column of a display grid', function () {
    Grid::make('report')
        ->columns([TextColumn::make('account')->sortable()])
        ->defaultSort('phantom')
        ->assertValid();
})->throws(InvalidArgumentException::class, 'is not a declared column');

it('rejects a non-sortable defaultSort on a server-side grid too (was a silent no-ORDER-BY)', function () {
    Grid::make('list')
        ->query(fn () => null)
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')->sortable(), TextColumn::make('code')])
        ->defaultSort('code')
        ->assertValid();
})->throws(InvalidArgumentException::class, 'is not ->sortable()');
