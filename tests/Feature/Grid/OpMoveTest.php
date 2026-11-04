<?php

declare(strict_types=1);

use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\Op;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Editing\OpResult;
use LaraGrid\Grid;
use LaraGrid\Tests\Hosts\VoucherLinesGridComponent;
use Livewire\Livewire;

/**
 * What: Pins the `move` op (plan F4) through the real OpApplier: `before` wins over `after`,
 *       neither means "to the end", anchors resolve among the other rows, a move onto the
 *       row's own position is an idempotent success, and an unknown row or anchor fails with
 *       the authoritative rows for a rollback.
 * Why:  Alt+Up / Alt+Down and the gutter drag reorder the client's rows optimistically; the save
 *       order of a voucher is positional, so the server must land the row exactly where the
 *       client did, and a blank trailing row moved up must stop counting as trailing.
 */
afterEach(fn () => VoucherLinesGridComponent::resetTuning());

function moveGrid(): Grid
{
    return Grid::make('lines')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')->required()]);
}

/**
 * @param  list<array<string, mixed>>  $ops
 */
function applyMoveOps(array $ops): OpResult
{
    $rows = [['_k' => 'a', 'name' => 'A'], ['_k' => 'b', 'name' => 'B'], ['_k' => 'c', 'name' => 'C'], ['_k' => 'd', 'name' => 'D']];
    $seq = 0;

    return (new OpApplier)->apply(moveGrid(), $rows, OpBatch::fromPayload([
        'baseVersion' => 0,
        'ops' => array_map(function (array $op) use (&$seq): array {
            return ['seq' => ++$seq] + $op;
        }, $ops),
    ]));
}

it('moves a row to the top, the bottom and the middle', function (array $op, array $order) {
    $result = applyMoveOps([['t' => 'move'] + $op]);

    expect($result->results[0]['ok'])->toBeTrue()
        ->and(array_column($result->rows, '_k'))->toBe($order);
})->with([
    'to the top (before the first row)' => [['row' => 'c', 'before' => 'a'], ['c', 'a', 'b', 'd']],
    'to the bottom (no anchor)' => [['row' => 'a'], ['b', 'c', 'd', 'a']],
    'to the bottom (after the last row)' => [['row' => 'b', 'after' => 'd'], ['a', 'c', 'd', 'b']],
    'down into the middle (before)' => [['row' => 'a', 'before' => 'd'], ['b', 'c', 'a', 'd']],
    'up into the middle (after)' => [['row' => 'd', 'after' => 'a'], ['a', 'd', 'b', 'c']],
    'before wins over after' => [['row' => 'd', 'before' => 'b', 'after' => 'c'], ['a', 'd', 'b', 'c']],
]);

it('treats a move onto its own position as an idempotent success', function () {
    $result = applyMoveOps([['t' => 'move', 'row' => 'b', 'before' => 'c'], ['t' => 'move', 'row' => 'b', 'after' => 'a']]);

    expect(array_column($result->results, 'ok'))->toBe([true, true])
        ->and(array_column($result->rows, '_k'))->toBe(['a', 'b', 'c', 'd'])
        ->and($result->version)->toBe(2);
});

it('fails an unknown row or anchor with the authoritative rows', function (array $op) {
    $result = applyMoveOps([['t' => 'move'] + $op]);

    expect($result->results[0]['ok'])->toBeFalse()
        ->and($result->results[0])->toHaveKey('rows')
        ->and(array_column($result->results[0]['rows'], '_k'))->toBe(['a', 'b', 'c', 'd'])
        ->and(array_column($result->rows, '_k'))->toBe(['a', 'b', 'c', 'd']);
})->with([
    'unknown row' => [['row' => 'ghost', 'before' => 'a']],
    'unknown anchor' => [['row' => 'a', 'before' => 'ghost']],
    'the row as its own anchor' => [['row' => 'a', 'after' => 'a']],
]);

it('makes a blank trailing row moved up validatable', function () {
    $rows = [['_k' => 'a', 'name' => 'A'], ['_k' => 'b', 'name' => 'B'], ['_k' => 'blank', 'name' => null]];

    $result = (new OpApplier)->apply(moveGrid(), $rows, OpBatch::fromPayload(['baseVersion' => 0, 'ops' => [
        ['seq' => 1, 't' => 'set', 'row' => 'blank', 'col' => 'name', 'v' => ''],
        ['seq' => 2, 't' => 'move', 'row' => 'blank', 'before' => 'a'],
        ['seq' => 3, 't' => 'set', 'row' => 'blank', 'col' => 'name', 'v' => ''],
    ]]));

    expect($result->results[0]['ok'])->toBeTrue('trailing: not validated')
        ->and($result->results[2]['ok'])->toBeFalse()
        ->and($result->results[2]['errors']['blank'])->toHaveKey('name');
});

it('requires row on a move op', function () {
    expect(fn () => Op::fromArray(['t' => 'move', 'seq' => 1, 'before' => 'a']))
        ->toThrow(InvalidArgumentException::class, 'A move op requires row.');
});

it('writes the moved order back to the host rows through gridOps', function () {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $first = $component->get('lines')[0]['_k'];

    $component->call('gridOps', 'lines', ['baseVersion' => 0, 'ops' => [
        ['t' => 'insert', 'seq' => 1, 'as' => 'n2', 'after' => $first],
        ['t' => 'set', 'seq' => 2, 'row' => 'n2', 'col' => 'narration', 'v' => 'second'],
        ['t' => 'move', 'seq' => 3, 'row' => 'n2', 'before' => $first],
    ]]);

    expect(array_column($component->get('lines'), '_k'))->toBe(['n2', $first])
        ->and($component->get('laraGridVersions')['lines'])->toBe(3);
});
