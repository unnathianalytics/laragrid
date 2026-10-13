<?php

declare(strict_types=1);

use LaraGrid\Columns\SearchSelectColumn;
use LaraGrid\Columns\SelectColumn;
use LaraGrid\Grid;

/**
 * What: Build-time and serialization contract of SearchSelectColumn::optionsDependOn() — the row
 *       keys a server picker's option search depends on.
 * Why:  The client keys its option cache by these values (pinned by run-option-cache-key.mjs);
 *       a misdeclared dependency would key the cache by a phantom value and silently reuse one
 *       row's options for another, so the grid fails loud at build time instead.
 */
function dependentPickerGrid(SearchSelectColumn $picker): Grid
{
    return Grid::make('lines')
        ->editable()->rowsFrom('lines')->authorize(fn (): bool => true)
        ->columns([
            SelectColumn::make('dc')->options(['D' => 'Dr', 'C' => 'Cr']),
            $picker,
        ]);
}

it('serializes the declared dependencies for the client cache key', function () {
    $grid = dependentPickerGrid(
        SearchSelectColumn::make('account_id')->optionsUsing(fn (string $term, array $row): array => [])->optionsDependOn('dc'),
    );

    $grid->assertValid();

    expect($grid->column('account_id')->toArray())->toHaveKey('optionsDependOn', ['dc']);
});

it('serializes an empty dependency list by default', function () {
    $grid = dependentPickerGrid(
        SearchSelectColumn::make('account_id')->optionsUsing(fn (string $term, array $row): array => []),
    );

    $grid->assertValid();

    expect($grid->column('account_id')->toArray())->toHaveKey('optionsDependOn', []);
});

it('rejects a dependency on an unknown column', function () {
    dependentPickerGrid(
        SearchSelectColumn::make('account_id')->optionsUsing(fn (string $term, array $row): array => [])->optionsDependOn(['side']),
    )->assertValid();
})->throws(InvalidArgumentException::class, 'optionsDependOn() references unknown column [side]');

it('rejects a picker that depends on itself', function () {
    dependentPickerGrid(
        SearchSelectColumn::make('account_id')->optionsUsing(fn (string $term, array $row): array => [])->optionsDependOn('account_id'),
    )->assertValid();
})->throws(InvalidArgumentException::class, 'optionsDependOn() references unknown column [account_id]');

it('rejects dependencies on a client-mode picker with no server options', function () {
    dependentPickerGrid(
        SearchSelectColumn::make('account_id')->options(['1' => 'Cash'])->optionsDependOn('dc'),
    )->assertValid();
})->throws(InvalidArgumentException::class, 'declares optionsDependOn() but no optionsUsing()');
