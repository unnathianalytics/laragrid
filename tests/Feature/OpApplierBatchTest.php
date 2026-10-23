<?php

declare(strict_types=1);

use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Grid;
use LaraGrid\Tests\Hosts\WideEditableGridComponent;

/**
 * What: The OpApplier's per-batch context (performance plan P4): one fresh-row template per
 *       batch, an O(1) key map the structural ops keep current, cached blank verdicts, and the
 *       last-non-blank marker that replaces the forward scan behind "blank trailing".
 *
 * Why:  A draft restore is N rows x C columns of SET ops; the old per-op scans made it
 *       quadratic. The contract (which row an op lands on, what counts as trailing) must not
 *       move while the cost does.
 */
function countingGrid(): Grid
{
    return (new class('lines') extends Grid
    {
        public int $templateCalls = 0;

        public function newRowTemplate(): array
        {
            $this->templateCalls++;

            return parent::newRowTemplate();
        }
    })
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->columns([
            TextColumn::make('name')->rules(['max:40']),
            IntegerColumn::make('qty'),
        ]);
}

/** @return list<array<string, mixed>> */
function blankRows(int $count): array
{
    return array_map(fn (int $i): array => ['_k' => 'r'.$i, 'name' => null, 'qty' => null], range(1, $count));
}

it('builds the fresh-row template once for a batch of 500 SET ops over 500 rows', function () {
    $grid = countingGrid();
    $ops = [];
    foreach (range(1, 500) as $i) {
        $ops[] = ['t' => 'set', 'seq' => $i, 'row' => 'r'.$i, 'col' => 'name', 'v' => 'Line '.$i];
    }

    $result = (new OpApplier)->apply($grid, blankRows(500), OpBatch::fromPayload(['ops' => $ops]));

    expect($grid->templateCalls)->toBe(1)
        ->and($result->version)->toBe(500)
        ->and(array_filter($result->results, fn (array $r): bool => ! $r['ok']))->toBe([])
        ->and($result->rows[499]['name'])->toBe('Line 500');
});

it('keeps the key index correct across insert, set, remove and dup in one batch', function () {
    $rows = [
        ['_k' => 'a', 'name' => 'A', 'qty' => 1],
        ['_k' => 'b', 'name' => 'B', 'qty' => 2],
        ['_k' => 'c', 'name' => 'C', 'qty' => 3],
    ];

    $result = (new OpApplier)->apply(countingGrid(), $rows, OpBatch::fromPayload(['ops' => [
        ['t' => 'insert', 'seq' => 1, 'as' => 'x', 'before' => 'b'],
        ['t' => 'set', 'seq' => 2, 'row' => 'x', 'col' => 'name', 'v' => 'X'],   // lands on the inserted row
        ['t' => 'set', 'seq' => 3, 'row' => 'c', 'col' => 'qty', 'v' => '30'],   // index shifted by the insert
        ['t' => 'remove', 'seq' => 4, 'row' => 'a'],
        ['t' => 'dup', 'seq' => 5, 'row' => 'c', 'as' => 'd'],
        ['t' => 'set', 'seq' => 6, 'row' => 'd', 'col' => 'name', 'v' => 'D'],   // the clone, not its source
        ['t' => 'set', 'seq' => 7, 'row' => 'b', 'col' => 'qty', 'v' => '20'],
        ['t' => 'set', 'seq' => 8, 'row' => 'a', 'col' => 'name', 'v' => 'ghost'], // removed → stale key
    ]]));

    expect(array_column($result->rows, '_k'))->toBe(['x', 'b', 'c', 'd'])
        ->and(array_column($result->rows, 'name'))->toBe(['X', 'B', 'C', 'D'])
        ->and(array_column($result->rows, 'qty'))->toBe([null, 20, 30, 30])
        ->and($result->results[7]['ok'])->toBeFalse()
        ->and($result->results[7]['errors']['a']['_row'])->toContain('no longer exists')
        ->and(array_filter(array_slice($result->results, 0, 7), fn (array $r): bool => ! $r['ok']))->toBe([]);
});

it('tracks the trailing-blank boundary as SETs fill and empty rows', function () {
    $grid = Grid::make('lines')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')->required(), IntegerColumn::make('qty')]);
    $rows = blankRows(3);

    // A SET of '' into the required name cell is the probe: it is an error only when the row
    // is NOT blank trailing (something non-blank follows it).
    $result = (new OpApplier)->apply($grid, $rows, OpBatch::fromPayload(['ops' => [
        ['t' => 'set', 'seq' => 1, 'row' => 'r3', 'col' => 'name', 'v' => ''],    // all blank → trailing → ok
        ['t' => 'set', 'seq' => 2, 'row' => 'r3', 'col' => 'qty', 'v' => '7'],    // r3 now non-blank
        ['t' => 'set', 'seq' => 3, 'row' => 'r1', 'col' => 'name', 'v' => ''],    // r3 follows → required fails
        ['t' => 'set', 'seq' => 4, 'row' => 'r3', 'col' => 'qty', 'v' => ''],     // r3 blank again → marker rescans
        ['t' => 'set', 'seq' => 5, 'row' => 'r1', 'col' => 'name', 'v' => ''],    // trailing again → ok
        ['t' => 'set', 'seq' => 6, 'row' => 'r2', 'col' => 'name', 'v' => 'Two'], // r2 non-blank
        ['t' => 'set', 'seq' => 7, 'row' => 'r1', 'col' => 'name', 'v' => ''],    // r2 follows → required fails
        ['t' => 'set', 'seq' => 8, 'row' => 'r3', 'col' => 'name', 'v' => ''],    // after r2 → trailing → ok
    ]]));

    expect(array_column($result->results, 'ok'))->toBe([true, true, false, true, true, true, false, true])
        ->and($result->results[2]['errors']['r1'])->toHaveKey('name')
        ->and($result->results[6]['errors']['r1'])->toHaveKey('name')
        // The footer counts rows up to the last non-blank one (r2): r3 stays blank trailing.
        ->and($result->rows[2]['name'])->toBe('');
});

it('restores a 2,000-row, 8-column browser draft within the time budget', function () {
    $host = new WideEditableGridComponent;
    $host->rows = [];

    $draft = [];
    foreach (range(1, 2000) as $i) {
        $row = ['_k' => 'd'.$i];
        foreach (range(1, 8) as $c) {
            $row['c'.$c] = "v{$i}-{$c}";
        }
        $draft[] = $row;
    }

    $started = microtime(true);
    $result = $host->gridRestoreDraft('wide', ['baseVersion' => 0, 'rows' => $draft]);
    $elapsed = microtime(true) - $started;

    expect($result['version'])->toBe(16000)
        ->and($result['rows'])->toHaveCount(2000)
        ->and($result['rows'][1999]['c8'])->toBe('v2000-8')
        ->and(array_filter($result['results'], fn (array $r): bool => ! $r['ok']))->toBe([])
        ->and($elapsed)->toBeLessThan(2.0);
});
