<?php

declare(strict_types=1);

use LaraGrid\Columns\SearchSelectColumn;
use LaraGrid\Editing\Op;
use LaraGrid\Tests\Hosts\VoucherLinesGridComponent;
use Livewire\Features\SupportTesting\Testable;
use Livewire\Livewire;

/**
 * What: Paste by label into server-mode pickers (plan F3), through the real gridOps and
 *       gridRestoreDraft request paths: a `lookup` SET resolves the pasted text to exactly one
 *       option id through the column's optionsUsing() closure, then runs the pick's onSelect
 *       enrichment and formulas; no match or several matches refuse the write.
 *
 * Why:  Before F3 a pasted label on a server-mode picker was stored AS the id (no whitelist in
 *       server mode). The client never guesses an id, so the server is where a label becomes one.
 *
 * When: Fast Feature coverage.
 */
afterEach(fn () => VoucherLinesGridComponent::resetTuning());

/**
 * @param  list<array<string, mixed>>  $ops
 * @return array<string, mixed>
 */
function lookupOps(Testable $component, array $ops): array
{
    return $component->call('gridOps', 'lines', [
        'baseVersion' => $component->get('laraGridVersions')['lines'] ?? 0,
        'ops' => $ops,
    ])->effects['returns'][0];
}

it('resolves a pasted label to its id, labels it and runs the pick enrichment', function () {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    $response = lookupOps($component, [
        ['t' => 'set', 'seq' => 1, 'row' => $key, 'col' => 'qty', 'v' => '2'],
        ['t' => 'set', 'seq' => 2, 'row' => $key, 'col' => 'account_id', 'v' => '  cement 50KG ', 'lookup' => true],
    ]);

    $line = $component->get('lines')[0];
    $patch = $response['results'][1]['patch'][$key];

    expect($response['results'][1]['ok'])->toBeTrue()
        ->and($line['account_id'])->toBe('a1')
        ->and($line['_labels']['account_id'])->toBe('Cement 50kg')
        ->and($line['rate'])->toBe('350.00')
        ->and($patch['account_id'])->toBe('a1')
        ->and($patch['_labels'])->toBe(['account_id' => 'Cement 50kg'])
        ->and($patch['rate'])->toBe('350.00')
        ->and((float) $patch['amount'])->toBe(700.0);
});

it('resolves an exact id as well as a label', function () {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    $response = lookupOps($component, [
        ['t' => 'set', 'seq' => 1, 'row' => $key, 'col' => 'account_id', 'v' => 'a2', 'lookup' => true],
    ]);

    expect($component->get('lines')[0]['account_id'])->toBe('a2')
        ->and($response['results'][0]['patch'][$key]['_labels'])->toBe(['account_id' => 'Steel Rod 12mm']);
});

it('refuses a label with no match or several matches and leaves the row unchanged', function (string $text, string $message) {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $key = $component->get('lines')[0]['_k'];
    $before = $component->get('lines')[0];

    $response = lookupOps($component, [
        ['t' => 'set', 'seq' => 1, 'row' => $key, 'col' => 'account_id', 'v' => $text, 'lookup' => true],
    ]);

    expect($response['results'][0]['ok'])->toBeFalse()
        ->and($response['results'][0]['errors'])->toBe([$key => ['account_id' => $message]])
        ->and($response['results'][0]['patch'])->toBe([])
        ->and($component->get('lines')[0])->toBe($before);
})->with([
    'no match' => ['Cemnt', 'No option matches "Cemnt".'],
    'two matches' => ['Sand', '"Sand" matches 2 options; pick it from the list.'],
]);

it('stores the raw text without lookup, as before', function () {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    lookupOps($component, [
        ['t' => 'set', 'seq' => 1, 'row' => $key, 'col' => 'account_id', 'v' => 'Cement 50kg'],
    ]);

    expect($component->get('lines')[0]['account_id'])->toBe('Cement 50kg')
        ->and($component->get('lines')[0]['_labels'] ?? [])->not->toHaveKey('account_id');
});

it('reads optionsDependOn values from the row as earlier ops in the batch left it', function () {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    $response = lookupOps($component, [
        ['t' => 'set', 'seq' => 1, 'row' => $key, 'col' => 'dc', 'v' => 'C'],
        ['t' => 'set', 'seq' => 2, 'row' => $key, 'col' => 'account_id', 'v' => 'Cement 50kg', 'lookup' => true],
        ['t' => 'set', 'seq' => 3, 'row' => $key, 'col' => 'dc', 'v' => 'D'],
        ['t' => 'set', 'seq' => 4, 'row' => $key, 'col' => 'account_id', 'v' => 'Cash', 'lookup' => true],
    ]);

    expect($response['results'][1]['patch'][$key]['account_id'])->toBe('c2')
        ->and($response['results'][3]['ok'])->toBeFalse()
        ->and($response['results'][3]['errors'][$key]['account_id'])->toBe('No option matches "Cash".');
});

it('runs the option closure once for a label pasted down several rows', function () {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    $response = lookupOps($component, [
        ['t' => 'insert', 'seq' => 1, 'as' => 'n2', 'after' => $key],
        ['t' => 'insert', 'seq' => 2, 'as' => 'n3', 'after' => 'n2'],
        ['t' => 'set', 'seq' => 3, 'row' => $key, 'col' => 'account_id', 'v' => 'Cement 50kg', 'lookup' => true],
        ['t' => 'set', 'seq' => 4, 'row' => 'n2', 'col' => 'account_id', 'v' => 'Cement 50kg', 'lookup' => true],
        ['t' => 'set', 'seq' => 5, 'row' => 'n3', 'col' => 'account_id', 'v' => 'Cement 50kg', 'lookup' => true],
    ]);

    expect(VoucherLinesGridComponent::$searches)->toBe(1)
        ->and(array_column($component->get('lines'), 'account_id'))->toBe(['a1', 'a1', 'a1'])
        ->and(array_filter($response['results'], fn (array $r): bool => ! $r['ok']))->toBe([]);
});

it('finds an exact label the sliced option search would drop', function () {
    // 60 longer labels contain the term and sort before the exact one ("A Bolt 01" < "Bolt").
    $options = array_map(fn (int $i): array => ['value' => 'v'.$i, 'label' => 'A Bolt '.str_pad((string) $i, 2, '0', STR_PAD_LEFT)], range(1, 60));
    $options[] = ['value' => 'vz', 'label' => 'Bolt'];
    $column = SearchSelectColumn::make('item_id')
        ->limit(50)
        ->optionsUsing(fn (string $term): array => array_values(array_filter(
            $options,
            fn (array $o): bool => stripos($o['label'], $term) !== false,
        )));

    expect($column->resolveOptions('Bolt'))->toHaveCount(50)
        ->and(array_column($column->resolveOptions('Bolt'), 'value'))->not->toContain('vz')
        ->and($column->resolveExact(' BOLT ', []))->toBe([['value' => 'vz', 'label' => 'Bolt']]);
});

it('re-resolves the draft cells marked as lookups and leaves the others raw', function () {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    $response = $component->call('gridRestoreDraft', 'lines', [
        'baseVersion' => 0,
        'rows' => [
            ['_k' => $key, 'dc' => 'D', 'account_id' => 'Cement 50kg', 'narration' => 'Steel Rod 12mm'],
            ['_k' => 'd2', 'dc' => 'D', 'account_id' => 'Sand Pit', 'narration' => null],
        ],
        'lookups' => [$key."\x1F".'account_id'],
    ])->effects['returns'][0];

    $lines = $component->get('lines');

    expect($lines[0]['account_id'])->toBe('a1')
        ->and($lines[0]['_labels']['account_id'])->toBe('Cement 50kg')
        ->and($lines[0]['narration'])->toBe('Steel Rod 12mm')
        ->and($lines[1]['account_id'])->toBe('Sand Pit')
        ->and(collect($response['rows'])->firstWhere('_k', $key)['account_id'])->toBe('a1');
});

it('accepts lookup on a set op only', function () {
    expect(Op::fromArray(['t' => 'set', 'seq' => 1, 'row' => 'a', 'col' => 'x', 'v' => 'y', 'lookup' => true])->lookup)->toBeTrue()
        ->and(Op::fromArray(['t' => 'set', 'seq' => 1, 'row' => 'a', 'col' => 'x', 'v' => 'y', 'lookup' => 'yes'])->lookup)->toBeFalse()
        ->and(fn () => Op::fromArray(['t' => 'remove', 'seq' => 1, 'row' => 'a', 'lookup' => true]))
        ->toThrow(InvalidArgumentException::class, 'Only a set op may carry lookup.');
});
