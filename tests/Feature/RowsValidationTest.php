<?php

declare(strict_types=1);

use Illuminate\Validation\ValidationException;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\RowsContext;
use LaraGrid\Grid;
use LaraGrid\Tests\Hosts\VoucherLinesGridComponent;
use Livewire\Features\SupportTesting\Testable;
use Livewire\Livewire;

/**
 * What: Grid-level validation (plan F5): ->validateRows(fn (RowsContext $rows)) sees every kept
 *       row at once. On save, gridRows() maps its row-keyed messages to the usual index keys
 *       (`lines.1.account_id`, `lines.0`, `lines`); with `live: true` every gridOps response
 *       ends with a `scope: 'rows'` entry keyed by `_k`; gridRestoreDraft carries one too.
 *
 * Why:  Cell and row rules cannot see "the same account twice" or "no credit line at all". The
 *       live entry is how the client learns both that a message appeared and that it is gone.
 *
 * When: Fast Feature coverage.
 */
afterEach(fn () => VoucherLinesGridComponent::resetTuning());

function rowsRuleHost(bool $live): Testable
{
    VoucherLinesGridComponent::$tune = fn (Grid $grid): Grid => $grid->validateRows(function (RowsContext $rows): void {
        $rows->unique('account_id', 'This account is already on another line.');
        if (! in_array('C', array_column($rows->rows(), 'dc'), true)) {
            $rows->error('At least one credit line is required.');
        }
        foreach ($rows->rows() as $row) {
            if ((int) ($row['qty'] ?? 0) > 100) {
                $rows->error('Quantity over 100 needs approval.', $row['_k']);
            }
        }
    }, live: $live);

    return Livewire::test(VoucherLinesGridComponent::class);
}

/**
 * @param  list<array<string, mixed>>  $ops
 * @return array<string, mixed>
 */
function rowsRuleOps(Testable $component, array $ops): array
{
    return $component->call('gridOps', 'lines', [
        'baseVersion' => $component->get('laraGridVersions')['lines'] ?? 0,
        'ops' => $ops,
    ])->effects['returns'][0];
}

/** Three filled D lines: a1, a1 (duplicate), a1 (duplicate), the last with qty 150. */
function seedDuplicateLines(Testable $component): array
{
    $first = $component->get('lines')[0]['_k'];
    rowsRuleOps($component, [
        ['t' => 'insert', 'seq' => 1, 'as' => 'k2', 'after' => $first],
        ['t' => 'insert', 'seq' => 2, 'as' => 'k3', 'after' => 'k2'],
        ['t' => 'set', 'seq' => 3, 'row' => $first, 'col' => 'account_id', 'v' => 'a1', 'label' => 'Cement 50kg'],
        ['t' => 'set', 'seq' => 4, 'row' => 'k2', 'col' => 'account_id', 'v' => 'a1', 'label' => 'Cement 50kg'],
        ['t' => 'set', 'seq' => 5, 'row' => 'k3', 'col' => 'account_id', 'v' => 'a1', 'label' => 'Cement 50kg'],
        ['t' => 'set', 'seq' => 6, 'row' => 'k3', 'col' => 'qty', 'v' => '150'],
    ]);

    return [$first, 'k2', 'k3'];
}

it('maps grid, row and cell messages to index keys on save, merged with the cell rules', function () {
    $component = rowsRuleHost(live: false);
    seedDuplicateLines($component);

    try {
        $component->instance()->gridRows('lines');
        $this->fail('gridRows() should have thrown.');
    } catch (ValidationException $e) {
        expect($e->errors())->toBe([
            'lines.1.account_id' => ['This account is already on another line.'],
            'lines.2.account_id' => ['This account is already on another line.'],
            'lines.2' => ['Quantity over 100 needs approval.'],
            'lines' => ['At least one credit line is required.'],
        ]);
    }
});

it('returns the clean rows when the grid-level rules pass', function () {
    $component = rowsRuleHost(live: false);
    [$first] = seedDuplicateLines($component);
    rowsRuleOps($component, [
        ['t' => 'set', 'seq' => 7, 'row' => 'k2', 'col' => 'account_id', 'v' => 'a2', 'label' => 'Steel Rod 12mm'],
        ['t' => 'set', 'seq' => 8, 'row' => 'k3', 'col' => 'dc', 'v' => 'C'],
        ['t' => 'set', 'seq' => 9, 'row' => 'k3', 'col' => 'account_id', 'v' => 'c1', 'label' => 'Cash'],
        ['t' => 'set', 'seq' => 10, 'row' => 'k3', 'col' => 'qty', 'v' => '5'],
    ]);

    $clean = $component->instance()->gridRows('lines');

    expect(array_column($clean, 'account_id'))->toBe(['a1', 'a2', 'c1'])
        ->and($clean[0])->not->toHaveKey('_k');
});

it('ends every live gridOps response with a rows-scope entry keyed by row key', function () {
    $component = rowsRuleHost(live: true);
    $first = $component->get('lines')[0]['_k'];

    $response = rowsRuleOps($component, [
        ['t' => 'insert', 'seq' => 1, 'as' => 'k2', 'after' => $first],
        ['t' => 'set', 'seq' => 2, 'row' => $first, 'col' => 'account_id', 'v' => 'a1'],
        ['t' => 'set', 'seq' => 3, 'row' => 'k2', 'col' => 'account_id', 'v' => 'a1'],
    ]);

    expect($response['results'])->toHaveCount(4)
        ->and(end($response['results']))->toBe([
            'seq' => 3,
            'ok' => false,
            'scope' => 'rows',
            'patch' => [],
            'errors' => [
                'k2' => ['account_id' => 'This account is already on another line.'],
                '_grid' => ['_row' => 'At least one credit line is required.'],
            ],
        ]);

    $fixed = rowsRuleOps($component, [
        ['t' => 'set', 'seq' => 4, 'row' => 'k2', 'col' => 'dc', 'v' => 'C'],
        ['t' => 'set', 'seq' => 5, 'row' => 'k2', 'col' => 'account_id', 'v' => 'c1'],
    ]);

    expect(end($fixed['results']))->toBe(['seq' => 5, 'ok' => true, 'scope' => 'rows', 'patch' => [], 'errors' => []]);
});

it('adds no rows-scope entry to a grid that validates rows on save only', function () {
    $component = rowsRuleHost(live: false);
    $first = $component->get('lines')[0]['_k'];

    $response = rowsRuleOps($component, [['t' => 'set', 'seq' => 1, 'row' => $first, 'col' => 'qty', 'v' => '2']]);

    expect($response['results'])->toHaveCount(1)
        ->and($response['results'][0])->not->toHaveKey('scope');
});

it('appends a rows-scope entry to a draft restore', function () {
    $component = rowsRuleHost(live: false);
    $first = $component->get('lines')[0]['_k'];

    $response = $component->call('gridRestoreDraft', 'lines', [
        'baseVersion' => 0,
        'rows' => [
            ['_k' => $first, 'dc' => 'D', 'account_id' => 'a1', 'qty' => '1'],
            ['_k' => 'd2', 'dc' => 'D', 'account_id' => 'a1', 'qty' => '1'],
        ],
    ])->effects['returns'][0];

    $entry = collect($response['results'])->firstWhere('scope', 'rows');

    expect($entry['ok'])->toBeFalse()
        ->and($entry['errors'])->toBe([
            'd2' => ['account_id' => 'This account is already on another line.'],
            '_grid' => ['_row' => 'At least one credit line is required.'],
        ]);
});

it('gives the validator the kept rows with keys and labels, and flags only later duplicates', function () {
    $context = new RowsContext([
        ['_k' => 'a', 'item' => 'x', '_labels' => ['item' => 'X']],
        ['_k' => 'b', 'item' => 'y'],
        ['_k' => 'c', 'item' => 'x'],
        ['_k' => 'd', 'item' => null],
        ['_k' => 'e', 'item' => null],
    ]);

    $context->unique('item')->error('Row note.', 'b')->error('Second note ignored.', 'b');

    expect($context->rows()[0]['_labels'])->toBe(['item' => 'X'])
        ->and($context->messages())->toBe([
            'c' => ['item' => 'Duplicate.'],
            'b' => ['_row' => 'Row note.'],
        ]);

    $seen = null;
    VoucherLinesGridComponent::$tune = function (Grid $grid) use (&$seen): Grid {
        return $grid->validateRows(function (RowsContext $rows) use (&$seen): void {
            $seen = $rows->rows();
        }, live: true);
    };
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $first = $component->get('lines')[0]['_k'];
    rowsRuleOps($component, [
        ['t' => 'insert', 'seq' => 1, 'as' => 'blank', 'after' => $first],
        ['t' => 'set', 'seq' => 2, 'row' => $first, 'col' => 'account_id', 'v' => 'a1', 'label' => 'Cement 50kg'],
    ]);

    expect(array_column($seen, '_k'))->toBe([$first])
        ->and($seen[0]['_labels'])->toBe(['account_id' => 'Cement 50kg']);
});

it('refuses validateRows on a grid that is not editable', function () {
    expect(fn () => Grid::make('report')->columns([TextColumn::make('a')])
        ->validateRows(fn (RowsContext $rows) => null)
        ->assertValid())
        ->toThrow(InvalidArgumentException::class, 'declares validateRows() but is not editable()');
});
