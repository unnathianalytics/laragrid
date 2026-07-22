<?php

declare(strict_types=1);

use LaraGrid\Columns\SearchSelectColumn;

/**
 * What: The resolveOptions() normalisation contract — canonical {value, label(, meta)} rows,
 *       alphabetical order, the column-side limit clamp, and the optional display-only `meta`
 *       annotation passing through untouched.
 * Why:  `meta` rides the gridOptions RPC to the editor (rendered right-aligned after the label,
 *       e.g. stock on hand); the normaliser must keep it when present and never invent the key
 *       when absent, or every host popup would paint stray empty spans.
 */
it('normalises resolver rows to {value, label} and passes a non-empty meta through', function () {
    $column = SearchSelectColumn::make('item_id')->optionsUsing(fn (string $term): array => [
        ['value' => 1, 'label' => 'Widget', 'meta' => '12 Nos'],
        ['value' => 2, 'label' => 'Bolt'],
        ['value' => 3, 'label' => 'Anvil', 'meta' => ''],
    ]);

    expect($column->resolveOptions(''))->toBe([
        ['value' => '3', 'label' => 'Anvil'],
        ['value' => '2', 'label' => 'Bolt'],
        ['value' => '1', 'label' => 'Widget', 'meta' => '12 Nos'],
    ]);
});

it('clamps resolver rows to the column limit after sorting, meta intact', function () {
    $column = SearchSelectColumn::make('item_id')->limit(2)->optionsUsing(fn (string $term): array => [
        ['value' => 1, 'label' => 'C'],
        ['value' => 2, 'label' => 'A', 'meta' => '5 Kg'],
        ['value' => 3, 'label' => 'B'],
    ]);

    expect($column->resolveOptions(''))->toBe([
        ['value' => '2', 'label' => 'A', 'meta' => '5 Kg'],
        ['value' => '3', 'label' => 'B'],
    ]);
});
