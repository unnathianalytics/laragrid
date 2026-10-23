<?php

declare(strict_types=1);

use LaraGrid\Columns\TextColumn;
use LaraGrid\Filters\SelectFilter;
use LaraGrid\Grid;
use LaraGrid\Views\ViewState;

/**
 * What: ViewState::sanitizeQuery()'s checkOptions flag (performance plan P7): false skips the
 *       per-filter accepts() call, so a SelectFilter's options closure never runs; the default
 *       keeps the check that drops a value the options no longer offer.
 */

/** A fresh grid whose one SelectFilter counts its options lookups into $calls. */
function optionsCountingGrid(int &$calls): Grid
{
    return Grid::make('g')
        ->columns([TextColumn::make('name'), TextColumn::make('type')])
        ->filters([
            SelectFilter::make('type')->options(function () use (&$calls): array {
                $calls++;

                return ['goods' => 'Goods', 'service' => 'Service'];
            }),
        ]);
}

it('does not resolve the filter options when checkOptions is false', function () {
    $calls = 0;
    $state = (new ViewState)->sanitizeQuery(
        optionsCountingGrid($calls),
        ['filters' => ['type' => 'retired-group'], 'search' => 'bol'],
        checkOptions: false,
    );

    expect($calls)->toBe(0);
    expect($state['filters'])->toBe(['type' => 'retired-group']);
    expect($state['search'])->toBe('bol');
});

it('still checks the options by default and drops a value they no longer offer', function () {
    $calls = 0;
    $viewState = new ViewState;

    $dropped = $viewState->sanitizeQuery(optionsCountingGrid($calls), ['filters' => ['type' => 'retired-group']]);
    expect($calls)->toBe(1);
    expect($dropped['filters'])->toBe([]);

    $calls = 0;
    $kept = $viewState->sanitizeQuery(optionsCountingGrid($calls), ['filters' => ['type' => 'goods']]);
    expect($calls)->toBe(1);
    expect($kept['filters'])->toBe(['type' => 'goods']);
});

it('keeps the shape whitelist when checkOptions is false', function () {
    $calls = 0;
    $state = (new ViewState)->sanitizeQuery(
        optionsCountingGrid($calls),
        ['filters' => ['undeclared' => 'x', 'type' => ['not', 'scalar']], 'sort' => 'nope'],
        checkOptions: false,
    );

    expect($state['filters'])->toBe([]);
    expect($state['sort'])->toBeNull();
    expect($calls)->toBe(0);
});
