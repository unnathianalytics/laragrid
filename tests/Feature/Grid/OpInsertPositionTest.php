<?php

declare(strict_types=1);

use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Grid;

/**
 * What: Pins the insert op's POSITIONING contract — `before` (undo restoring a removed row at
 *       its original index, including index 0), `after` (the classic Insert key), and the
 *       append default — through the real OpApplier.
 * Why:  Undo of a row delete round-trips as insert+sets; if the server placed the row anywhere
 *       but where the client optimistically restored it, the two row orders would silently
 *       diverge (G1 is keyed, but SAVE order is positional for vouchers).
 */
function insertGrid(): Grid
{
    return Grid::make('lines')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')]);
}

function applyInsertOp(array $rows, array $op): array
{
    $batch = OpBatch::fromPayload(['baseVersion' => 0, 'ops' => [['seq' => 1] + $op]]);
    $result = (new OpApplier)->apply(insertGrid(), $rows, $batch);

    expect($result->results[0]['ok'])->toBeTrue();

    return array_column($result->rows, '_k');
}

$rows = [['_k' => 'a', 'name' => 'A'], ['_k' => 'b', 'name' => 'B']];

it('inserts BEFORE a named row — including at the very top', function () use ($rows) {
    expect(applyInsertOp($rows, ['t' => 'insert', 'as' => 'x', 'before' => 'a']))
        ->toBe(['x', 'a', 'b']);

    expect(applyInsertOp($rows, ['t' => 'insert', 'as' => 'x', 'before' => 'b']))
        ->toBe(['a', 'x', 'b']);
});

it('prefers before over after when both are sent', function () use ($rows) {
    expect(applyInsertOp($rows, ['t' => 'insert', 'as' => 'x', 'before' => 'a', 'after' => 'b']))
        ->toBe(['x', 'a', 'b']);
});

it('falls back to after, then to append', function () use ($rows) {
    expect(applyInsertOp($rows, ['t' => 'insert', 'as' => 'x', 'after' => 'a']))
        ->toBe(['a', 'x', 'b']);

    expect(applyInsertOp($rows, ['t' => 'insert', 'as' => 'x']))
        ->toBe(['a', 'b', 'x']);

    // An unknown before key (a raced structural change) degrades to append, never a crash.
    expect(applyInsertOp($rows, ['t' => 'insert', 'as' => 'x', 'before' => 'ghost']))
        ->toBe(['a', 'b', 'x']);
});
