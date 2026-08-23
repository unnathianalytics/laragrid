<?php

declare(strict_types=1);

use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\EditableGridComponent;
use Livewire\Livewire;

it('serializes opt-in local draft recovery and rejects unsafe declarations', function () {
    $grid = Grid::make('lines')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->persistDraft('local', 'tenant-7:voucher-4')
        ->columns([TextColumn::make('name')]);

    expect((new ConfigSerializer)->serialize($grid)['layout']['draft'])
        ->toBe(['mode' => 'local', 'key' => 'tenant-7:voucher-4']);

    expect(fn () => Grid::make('x')->persistDraft('server'))
        ->toThrow(InvalidArgumentException::class, 'reserved and not implemented');

    expect(fn () => (new ConfigSerializer)->serialize(
        Grid::make('display')->persistDraft()->columns([TextColumn::make('name')])
    ))->toThrow(InvalidArgumentException::class, 'not editable');
});

it('allows row virtualization to be tuned or disabled per grid', function () {
    $grid = Grid::make('large')
        ->columns([TextColumn::make('name')])
        ->virtualizeRowsAbove(1200);
    expect((new ConfigSerializer)->serialize($grid)['layout']['virtualizeAbove'])->toBe(1200);

    expect((new ConfigSerializer)->serialize(
        Grid::make('print')->columns([TextColumn::make('name')])->virtualizeRowsAbove(0)
    )['layout']['virtualizeAbove'])->toBe(0);

    expect(fn () => Grid::make('bad')->virtualizeRowsAbove(50))
        ->toThrow(InvalidArgumentException::class, 'at least 100');
});

it('validates every fill target and reports errors by cell', function () {
    $grid = Grid::make('lines')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')->rules(['max:3'])]);
    $rows = [
        ['_k' => 'a', 'name' => 'TOOLONG'],
        ['_k' => 'b', 'name' => 'ok'],
        ['_k' => 'c', 'name' => 'ok'],
    ];

    $result = (new OpApplier)->apply($grid, $rows, OpBatch::fromPayload(['ops' => [
        ['t' => 'fill', 'seq' => 1, 'col' => 'name', 'rows' => ['a', 'b', 'c']],
    ]]));

    expect($result->results[0]['ok'])->toBeFalse()
        ->and($result->results[0]['errors'])->toHaveKeys(['b', 'c'])
        ->and($result->results[0]['patch']['b']['name'])->toBe('TOOLONG')
        ->and($result->rows[1]['name'])->toBe('TOOLONG');
});

it('makes echoed-key insert and duplicate retries idempotent', function () {
    $grid = Grid::make('lines')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')]);
    $rows = [['_k' => 'a', 'name' => 'A']];
    $applier = new OpApplier;

    $insert = OpBatch::fromPayload(['ops' => [
        ['t' => 'insert', 'seq' => 1, 'after' => 'a', 'as' => 'new'],
    ]]);
    $once = $applier->apply($grid, $rows, $insert);
    $twice = $applier->apply($grid, $once->rows, $insert);
    expect(array_column($twice->rows, '_k'))->toBe(['a', 'new']);

    $duplicate = OpBatch::fromPayload(['ops' => [
        ['t' => 'dup', 'seq' => 2, 'row' => 'a', 'as' => 'copy'],
    ]]);
    $once = $applier->apply($grid, $twice->rows, $duplicate);
    $twice = $applier->apply($grid, $once->rows, $duplicate);
    expect(array_column($twice->rows, '_k'))->toBe(['a', 'copy', 'new']);
});

it('rejects a stale base version without applying the operation', function () {
    $grid = Grid::make('lines')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')]);
    $rows = [['_k' => 'a', 'name' => 'current']];
    $result = (new OpApplier)->apply(
        $grid,
        $rows,
        OpBatch::fromPayload([
            'baseVersion' => 2,
            'ops' => [['t' => 'set', 'seq' => 1, 'row' => 'a', 'col' => 'name', 'v' => 'stale']],
        ]),
        version: 3,
    );

    expect($result->version)->toBe(3)
        ->and($result->rows)->toBe($rows)
        ->and($result->results[0]['conflict'])->toBeTrue();
});

it('keeps a locked component-scoped server revision across Livewire requests', function () {
    $component = Livewire::test(EditableGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    $component->call('gridOps', 'lines', [
        'baseVersion' => 0,
        'ops' => [['t' => 'set', 'seq' => 1, 'row' => $key, 'col' => 'narration', 'v' => 'first']],
    ]);
    expect($component->get('lines')[0]['narration'])->toBe('first')
        ->and($component->get('laraGridVersions')['lines'])->toBe(1);

    $component->call('gridOps', 'lines', [
        'baseVersion' => 0,
        'ops' => [['t' => 'set', 'seq' => 2, 'row' => $key, 'col' => 'narration', 'v' => 'stale']],
    ]);
    expect($component->get('lines')[0]['narration'])->toBe('first')
        ->and($component->get('laraGridVersions')['lines'])->toBe(1);

    $component->call('gridOps', 'lines', [
        'baseVersion' => 1,
        'ops' => [['t' => 'set', 'seq' => 3, 'row' => $key, 'col' => 'narration', 'v' => 'latest']],
    ]);
    expect($component->get('lines')[0]['narration'])->toBe('latest')
        ->and($component->get('laraGridVersions')['lines'])->toBe(2);
});

it('authoritatively rehydrates browser draft rows through normal casts and validation', function () {
    $component = Livewire::test(EditableGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    $component->call('gridRestoreDraft', 'lines', [
        'baseVersion' => 0,
        'rows' => [[
            '_k' => $key,
            'dc' => 'C',
            'narration' => 'Recovered',
        ]],
    ]);

    $rows = $component->get('lines');
    $returned = data_get($component->effects, 'returns.0');
    expect($rows)->toHaveCount(1)
        ->and($rows[0]['dc'])->toBe('C')
        ->and($rows[0]['narration'])->toBe('Recovered')
        ->and($returned['rows'][0]['narration'])->toBe('Recovered')
        ->and($component->get('laraGridVersions')['lines'])->toBe(2);
});

it('runs authoritative whole-grid validation at the gridRows save boundary', function () {
    Livewire::test(EditableGridComponent::class)
        ->set('lines', [[
            '_k' => 'bad',
            'dc' => 'D',
            'narration' => 'This narration is too long',
        ]])
        ->call('gridRows', 'lines')
        ->assertHasErrors(['lines.0.narration']);

    Livewire::test(EditableGridComponent::class)
        ->set('lines', [])
        ->call('gridRows', 'lines')
        ->assertHasErrors(['lines']);
});
