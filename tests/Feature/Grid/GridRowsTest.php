<?php

declare(strict_types=1);

use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\FormulaColumn;
use LaraGrid\Columns\HiddenColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Support\RowSerializer;

/**
 * What: Locks the cleanliness contract of the rows a host persists — RowSerializer::cleanEditableRows()
 *       (the engine behind WithLaraGrid::gridRows()): blank trailing rows dropped, client-only keys
 *       (`_k`, `_rowClass`, `_cellClass`) stripped, carried non-editable values preserved.
 *
 * Why:  The grid's stable `_k` and the auto-append blank row are pure client/transport concerns
 *       (plan §3.3, G1/G4); if either leaked into a save(), the persisted data would carry grid
 *       bookkeeping. This is the guard that keeps the boundary honest — the host reads these rows,
 *       never the raw bound property.
 */
function rowsGrid(): Grid
{
    return Grid::make('lines')
        ->editable()->rowsFrom('lines')->authorize(fn () => true)
        ->columns([
            SerialColumn::make(),
            TextColumn::make('name'),
            DecimalColumn::make('rate')->scale(2),
            FormulaColumn::make('amount')->formula('rate * 1'),
            HiddenColumn::make('uom_id'),
        ]);
}

it('strips blank trailing rows and the _k key, keeps carried values', function () {
    $rows = [
        ['_k' => 'k1', 'name' => 'Widget', 'rate' => 5000, 'amount' => 5000.0, 'uom_id' => 7],
        ['_k' => 'k2', 'name' => 'Gadget', 'rate' => 3000, 'amount' => 3000.0, 'uom_id' => 3],
        ['_k' => 'kBlank', 'name' => null, 'rate' => null, 'amount' => null, 'uom_id' => null],
    ];

    $clean = (new RowSerializer)->cleanEditableRows(rowsGrid(), $rows);

    expect($clean)->toHaveCount(2)
        ->and($clean[0])->not->toHaveKey('_k')
        ->and($clean[0])->toBe(['name' => 'Widget', 'rate' => 5000, 'amount' => 5000.0, 'uom_id' => 7])
        ->and($clean[1]['uom_id'])->toBe(3);
});

it('drops MULTIPLE blank trailing rows but keeps a blank row that has content after it', function () {
    $rows = [
        ['_k' => 'k1', 'name' => 'Widget', 'rate' => 5000, 'amount' => 5000.0, 'uom_id' => 1],
        ['_k' => 'kGap', 'name' => null, 'rate' => null, 'amount' => null, 'uom_id' => null],
        ['_k' => 'k2', 'name' => 'Gadget', 'rate' => 3000, 'amount' => 3000.0, 'uom_id' => 2],
        ['_k' => 'kB1', 'name' => null, 'rate' => null, 'amount' => null, 'uom_id' => null],
        ['_k' => 'kB2', 'name' => null, 'rate' => null, 'amount' => null, 'uom_id' => null],
    ];

    $clean = (new RowSerializer)->cleanEditableRows(rowsGrid(), $rows);

    // The two trailing blanks go; the middle blank (content follows it) stays.
    expect($clean)->toHaveCount(3)
        ->and(array_column($clean, 'name'))->toBe(['Widget', null, 'Gadget']);
});

it('strips _rowClass and _cellClass bookkeeping keys', function () {
    $rows = [
        ['_k' => 'k1', 'name' => 'Widget', 'rate' => 5000, 'amount' => 5000.0, 'uom_id' => 1,
            '_rowClass' => 'is-flagged', '_cellClass' => ['rate' => 'text-rose-500']],
    ];

    $clean = (new RowSerializer)->cleanEditableRows(rowsGrid(), $rows);

    expect($clean[0])->not->toHaveKey('_rowClass')
        ->and($clean[0])->not->toHaveKey('_cellClass')
        ->and($clean[0]['name'])->toBe('Widget');
});

it('strips the _labels display bag (M5 picker labels never persist)', function () {
    $rows = [
        ['_k' => 'k1', 'name' => 'Widget', 'rate' => 5000, 'amount' => 5000.0, 'uom_id' => 1,
            '_labels' => ['item_id' => 'Hex Bolt', 'uom' => 'KG']],
    ];

    $clean = (new RowSerializer)->cleanEditableRows(rowsGrid(), $rows);

    expect($clean[0])->not->toHaveKey('_labels')
        ->and($clean[0]['name'])->toBe('Widget');
});

it('returns an empty list when every row is blank', function () {
    $rows = [
        ['_k' => 'k1', 'name' => null, 'rate' => null, 'amount' => null, 'uom_id' => null],
        ['_k' => 'k2', 'name' => '', 'rate' => 0, 'amount' => null, 'uom_id' => null],
    ];

    expect((new RowSerializer)->cleanEditableRows(rowsGrid(), $rows))->toBe([]);
});
