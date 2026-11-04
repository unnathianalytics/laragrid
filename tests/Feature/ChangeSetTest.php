<?php

declare(strict_types=1);

use Illuminate\Validation\ValidationException;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\OpResult;
use LaraGrid\Editing\RowsContext;
use LaraGrid\Grid;
use LaraGrid\Support\RowSerializer;
use LaraGrid\Tests\Hosts\VoucherLinesGridComponent;
use Livewire\Features\SupportTesting\Testable;
use Livewire\Livewire;

/**
 * What: The change-set API (plan F6) on a ->trackChanges() grid: against the baseline taken at
 *       reseedGrid() (or the first op, or an empty one at gridMountRows()), gridChanges() sorts
 *       the kept rows into inserted / updated (with per-cell {from, to}) / unchanged, lists
 *       removed baseline rows with their baseline values, and reports reordering. An undo of a
 *       remove reads as unchanged; markGridSaved() starts a new baseline.
 *
 * Why:  An edit-existing-document save must update, insert and delete lines rather than
 *       rewrite them all — and a deleted-then-undone line must not become delete + insert.
 *
 * When: Fast Feature coverage, through the real gridOps / gridRestoreDraft request paths.
 */
afterEach(fn () => VoucherLinesGridComponent::resetTuning());

/** @return list<array<string, mixed>> */
function baselineLines(): array
{
    return [
        ['_k' => 'l1', 'dc' => 'D', 'account_id' => 'a1', '_labels' => ['account_id' => 'Cement 50kg'], 'narration' => 'one', 'qty' => 1, 'rate' => 10.0, 'amount' => 10.0],
        ['_k' => 'l2', 'dc' => 'D', 'account_id' => 'a2', '_labels' => ['account_id' => 'Steel Rod 12mm'], 'narration' => 'two', 'qty' => 2, 'rate' => '72.50', 'amount' => 145.0],
        ['_k' => 'l3', 'dc' => 'D', 'account_id' => 'a3', '_labels' => ['account_id' => 'Sand'], 'narration' => 'three', 'qty' => 3, 'rate' => '40.00', 'amount' => 120.0],
    ];
}

function trackedDocument(bool $track = true): Testable
{
    VoucherLinesGridComponent::$tune = fn (Grid $grid): Grid => $grid->trackChanges($track);

    return Livewire::test(VoucherLinesGridComponent::class)->call('loadDocument', baselineLines());
}

/**
 * @param  list<array<string, mixed>>  $ops
 */
function changeOps(Testable $component, array $ops): void
{
    $seq = 100 * (($component->get('laraGridVersions')['lines'] ?? 0) + 1);
    $component->call('gridOps', 'lines', [
        'baseVersion' => $component->get('laraGridVersions')['lines'] ?? 0,
        'ops' => array_map(function (array $op) use (&$seq): array {
            return ['seq' => ++$seq] + $op;
        }, $ops),
    ]);
}

/** @return array<string, mixed> */
function changeSet(Testable $component): array
{
    return $component->call('changes')->effects['returns'][0];
}

/** @return array<string, list<string>> */
function buckets(array $changes): array
{
    return array_map(
        fn (array $entries): array => array_column($entries, 'key'),
        array_intersect_key($changes, array_flip(['inserted', 'updated', 'removed', 'unchanged'])),
    );
}

it('reports a freshly loaded document as unchanged', function () {
    $changes = changeSet(trackedDocument());

    expect(buckets($changes))->toBe(['inserted' => [], 'updated' => [], 'removed' => [], 'unchanged' => ['l1', 'l2', 'l3']])
        ->and($changes['reordered'])->toBeFalse()
        ->and($changes['order'])->toBe(['l1', 'l2', 'l3'])
        ->and($changes['unchanged'][0]['row'])->not->toHaveKeys(['_k', '_labels', '_orig']);
});

it('lists an edited cell under updated, and an edit back as unchanged', function () {
    $component = trackedDocument();

    changeOps($component, [['t' => 'set', 'row' => 'l1', 'col' => 'qty', 'v' => '3']]);
    $changes = changeSet($component);

    expect(buckets($changes)['updated'])->toBe(['l1'])
        ->and($changes['updated'][0]['changes'])->toBe(['qty' => ['from' => 1, 'to' => 3]])
        ->and($changes['updated'][0]['row']['qty'])->toBe(3);

    // The seeded 10.0 and an applied '10.00' are the same decimal; qty goes back to 1.
    changeOps($component, [
        ['t' => 'set', 'row' => 'l1', 'col' => 'qty', 'v' => '1'],
        ['t' => 'set', 'row' => 'l1', 'col' => 'rate', 'v' => '10'],
    ]);

    expect(buckets(changeSet($component))['unchanged'])->toBe(['l1', 'l2', 'l3']);
});

it('lists inserted rows, removed rows with their baseline values, and reordering', function () {
    $component = trackedDocument();

    changeOps($component, [
        ['t' => 'set', 'row' => 'l2', 'col' => 'narration', 'v' => 'edited before removal'],
        ['t' => 'remove', 'row' => 'l2'],
        ['t' => 'insert', 'as' => 'n1', 'after' => 'l3'],
        ['t' => 'set', 'row' => 'n1', 'col' => 'narration', 'v' => 'new line'],
        ['t' => 'move', 'row' => 'l3', 'before' => 'l1'],
    ]);
    $changes = changeSet($component);

    expect(buckets($changes))->toBe(['inserted' => ['n1'], 'updated' => [], 'removed' => ['l2'], 'unchanged' => ['l3', 'l1']])
        ->and($changes['removed'][0]['row']['narration'])->toBe('two')
        ->and($changes['removed'][0]['row'])->not->toHaveKeys(['_k', '_orig'])
        ->and($changes['inserted'][0]['row']['narration'])->toBe('new line')
        ->and($changes['reordered'])->toBeTrue()
        ->and($changes['order'])->toBe(['l3', 'l1', 'n1']);
});

it('reads a removed-then-undone row as unchanged, and an inserted-then-removed row nowhere', function () {
    $component = trackedDocument();

    changeOps($component, [['t' => 'remove', 'row' => 'l2']]);
    expect(buckets(changeSet($component))['removed'])->toBe(['l2']);

    // The client's undo: an insert under the same key, positioned, plus a set per value.
    changeOps($component, [
        ['t' => 'insert', 'as' => 'l2', 'before' => 'l3'],
        ['t' => 'set', 'row' => 'l2', 'col' => 'dc', 'v' => 'D'],
        ['t' => 'set', 'row' => 'l2', 'col' => 'account_id', 'v' => 'a2', 'label' => 'Steel Rod 12mm'],
        ['t' => 'set', 'row' => 'l2', 'col' => 'narration', 'v' => 'two'],
        ['t' => 'set', 'row' => 'l2', 'col' => 'qty', 'v' => '2'],
        ['t' => 'set', 'row' => 'l2', 'col' => 'rate', 'v' => '72.50'],
        ['t' => 'insert', 'as' => 'tmp', 'after' => 'l3'],
        ['t' => 'set', 'row' => 'tmp', 'col' => 'narration', 'v' => 'gone soon'],
        ['t' => 'remove', 'row' => 'tmp'],
    ]);
    $changes = changeSet($component);

    expect(buckets($changes))->toBe(['inserted' => [], 'updated' => [], 'removed' => [], 'unchanged' => ['l1', 'l2', 'l3']])
        ->and($changes['reordered'])->toBeFalse()
        ->and($component->get('laraGridRemoved')['lines'])->toBe([]);
});

it('starts a new baseline on markGridSaved and on reseed', function () {
    $component = trackedDocument();
    changeOps($component, [
        ['t' => 'set', 'row' => 'l1', 'col' => 'qty', 'v' => '9'],
        ['t' => 'remove', 'row' => 'l3'],
        ['t' => 'move', 'row' => 'l2', 'before' => 'l1'],
    ]);

    $component->call('saved');
    $changes = changeSet($component);

    expect(buckets($changes))->toBe(['inserted' => [], 'updated' => [], 'removed' => [], 'unchanged' => ['l2', 'l1']])
        ->and($changes['reordered'])->toBeFalse()
        ->and(array_column($component->get('lines'), '_orig'))->toBe([]);

    changeOps($component, [['t' => 'set', 'row' => 'l1', 'col' => 'qty', 'v' => '4']]);
    $component->call('loadDocument', baselineLines());

    expect(buckets(changeSet($component))['unchanged'])->toBe(['l1', 'l2', 'l3'])
        ->and(array_column($component->get('lines'), '_orig'))->toBe([]);
});

it('reports every filled row of a fresh gridMountRows document as inserted', function () {
    VoucherLinesGridComponent::$tune = fn (Grid $grid): Grid => $grid->trackChanges();
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $first = $component->get('lines')[0]['_k'];

    changeOps($component, [
        ['t' => 'set', 'row' => $first, 'col' => 'narration', 'v' => 'first'],
        ['t' => 'insert', 'as' => 'n2', 'after' => $first],
        ['t' => 'set', 'row' => 'n2', 'col' => 'narration', 'v' => 'second'],
        ['t' => 'insert', 'as' => 'blank', 'after' => 'n2'],
    ]);

    expect(buckets(changeSet($component)))->toBe(['inserted' => [$first, 'n2'], 'updated' => [], 'removed' => [], 'unchanged' => []]);
});

it('takes the baseline at the first op when the host assigned rows without reseeding', function () {
    VoucherLinesGridComponent::$tune = fn (Grid $grid): Grid => $grid->trackChanges();
    VoucherLinesGridComponent::$mountLines = baselineLines();
    $component = Livewire::test(VoucherLinesGridComponent::class);
    expect($component->get('laraGridBaseline'))->toBe([]);

    changeOps($component, [['t' => 'set', 'row' => 'l3', 'col' => 'narration', 'v' => 'changed']]);

    expect(buckets(changeSet($component)))->toBe(['inserted' => [], 'updated' => ['l3'], 'removed' => [], 'unchanged' => ['l1', 'l2']]);
});

it('sees a baseline row missing from a restored draft as removed', function () {
    $component = trackedDocument();
    $rows = baselineLines();

    $component->call('gridRestoreDraft', 'lines', [
        'baseVersion' => 0,
        'rows' => [
            ['_k' => 'l1', 'dc' => 'D', 'account_id' => 'a1', 'narration' => 'one', 'qty' => '5', 'rate' => '10.00'],
            ['_k' => 'l3', 'dc' => 'D', 'account_id' => 'a3', 'narration' => 'three', 'qty' => '3', 'rate' => '40.00'],
            ['_k' => 'd9', 'dc' => 'D', 'account_id' => null, 'narration' => 'from the draft', 'qty' => null, 'rate' => null],
        ],
    ]);
    $changes = changeSet($component);

    expect(buckets($changes))->toBe(['inserted' => ['d9'], 'updated' => ['l1'], 'removed' => ['l2'], 'unchanged' => ['l3']])
        ->and($changes['removed'][0]['row']['narration'])->toBe($rows[1]['narration'])
        ->and($changes['updated'][0]['changes'])->toBe(['qty' => ['from' => 1, 'to' => 5]]);
});

it('throws the same ValidationException as gridRows on invalid rows', function () {
    VoucherLinesGridComponent::$tune = fn (Grid $grid): Grid => $grid->trackChanges()
        ->validateRows(fn (RowsContext $rows) => $rows->unique('account_id'));
    $component = Livewire::test(VoucherLinesGridComponent::class)->call('loadDocument', baselineLines());
    changeOps($component, [['t' => 'set', 'row' => 'l3', 'col' => 'account_id', 'v' => 'a1']]);

    $errors = function (Closure $call): array {
        try {
            $call();
        } catch (ValidationException $e) {
            return $e->errors();
        }

        return [];
    };

    $fromRows = $errors(fn () => $component->instance()->gridRows('lines'));
    expect($fromRows)->toBe(['lines.2.account_id' => ['Duplicate.']])
        ->and($errors(fn () => $component->instance()->changes()))->toBe($fromRows);
});

it('never sends _orig to the browser and leaves untracked rows without it', function () {
    $component = trackedDocument();
    changeOps($component, [['t' => 'set', 'row' => 'l1', 'col' => 'qty', 'v' => '7']]);

    expect($component->get('lines')[0]['_orig'])->toBe(['qty' => 1])
        ->and($component->call('gridReseedRows', 'lines')->effects['returns'][0]['rows'][0])->not->toHaveKey('_orig')
        ->and((new RowSerializer)->serializeMany($component->instance()->gridDefinition('lines'), $component->get('lines'))[0])
        ->not->toHaveKey('_orig')
        ->and($component->instance()->gridRows('lines')[0])->not->toHaveKey('_orig');

    $untracked = trackedDocument(track: false);
    changeOps($untracked, [
        ['t' => 'set', 'row' => 'l1', 'col' => 'qty', 'v' => '7'],
        ['t' => 'remove', 'row' => 'l2'],
        ['t' => 'insert', 'as' => 'n1'],
        ['t' => 'dup', 'row' => 'l1', 'as' => 'n2'],
    ]);

    expect(array_column($untracked->get('lines'), '_orig'))->toBe([])
        ->and($untracked->get('laraGridBaseline'))->toBe([])
        ->and($untracked->get('laraGridRemoved'))->toBe([])
        ->and(fn () => $untracked->instance()->changes())->toThrow(InvalidArgumentException::class, 'does not track changes');
});

it('keeps the change-tracking bookkeeping off the gridOps wire', function () {
    $result = new OpResult(version: 1, results: [], footer: [], rows: [['_k' => 'a']], refreshHost: false, inserted: ['a'], removed: [['_k' => 'b']]);

    expect(array_keys($result->toArray()))->toBe(['version', 'results', 'footer']);
});

it('refuses trackChanges on a grid that is not editable', function () {
    expect(fn () => Grid::make('report')->columns([TextColumn::make('a')])->trackChanges()->assertValid())
        ->toThrow(InvalidArgumentException::class, 'declares trackChanges() but is not editable()');
});
