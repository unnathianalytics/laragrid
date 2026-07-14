<?php

declare(strict_types=1);

use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\EditableGridComponent;
use Livewire\Livewire;

function p6Layout(Grid $grid): array
{
    return (new ConfigSerializer)->serialize($grid)['layout'];
}

it('serializes the P6 behavior chains into layout only when declared', function () {
    $bare = p6Layout(Grid::make('bare')->columns([TextColumn::make('name')]));
    expect($bare)->not->toHaveKeys(['focus', 'sizing', 'emptyState']);
    expect($bare['toolbar'])->toBe(['search' => true, 'filters' => true, 'perPage' => true, 'chooser' => true]);

    $full = p6Layout(
        Grid::make('full')->columns([TextColumn::make('name')])
            ->focusOnMount()
            ->focusOutTo('[data-save]')
            ->onCompleteFocus('#post')
            ->height('420px')
            ->emptyState('Nothing here')
    );
    expect($full['focus'])->toBe(['onMount' => true, 'outTo' => '[data-save]', 'complete' => '#post']);
    expect($full['sizing'])->toBe(['height' => '420px']);
    expect($full['emptyState'])->toBe('Nothing here');
});

it('resolves toolbar config defaults, per-grid overrides, and suppression', function () {
    config()->set('laragrid.toolbar.search', false);
    $grid = Grid::make('t')->columns([TextColumn::make('name')]);
    expect($grid->getToolbar())->toBe(['search' => false, 'filters' => true, 'perPage' => true, 'chooser' => true]);

    $override = Grid::make('t2')->columns([TextColumn::make('name')])->toolbar(search: true, chooser: false);
    expect($override->getToolbar())->toBe(['search' => true, 'filters' => true, 'perPage' => true, 'chooser' => false]);

    $off = Grid::make('t3')->columns([TextColumn::make('name')])->toolbar(false);
    expect($off->getToolbar())->toBeFalse();
    expect(p6Layout($off)['toolbar'])->toBeFalse();
});

it('rejects defaultRows/newRowUsing on a non-editable grid at build time', function () {
    (new ConfigSerializer)->serialize(
        Grid::make('bad')->columns([TextColumn::make('name')])->defaultRows(2)
    );
})->throws(InvalidArgumentException::class, 'not editable()');

it('seeds mount rows from defaultRows + the newRowUsing factory', function () {
    $component = Livewire::test(EditableGridComponent::class);

    $lines = $component->get('lines');

    expect($lines)->toHaveCount(2);
    foreach ($lines as $line) {
        expect($line['_k'])->toBeString()->not->toBe('');
        expect($line['dc'])->toBe('D');        // factory default
        expect($line['narration'])->toBeNull(); // template null
    }
    // Distinct keys.
    expect($lines[0]['_k'])->not->toBe($lines[1]['_k']);
});

it('grows rows through op INSERT with the same factory defaults', function () {
    Livewire::test(EditableGridComponent::class)
        ->call('gridOps', 'lines', ['ops' => [
            ['t' => 'insert', 'seq' => 1, 'after' => null, 'as' => 'fresh1'],
        ]])
        ->tap(function ($component) {
            $lines = $component->get('lines');
            $fresh = collect($lines)->firstWhere('_k', 'fresh1');
            expect($fresh)->not->toBeNull();
            expect($fresh['dc'])->toBe('D'); // newRowUsing applied server-side too
        });
});

it('attaches a rows snapshot on a structural failure (minRows refusal) but not on validation errors', function () {
    $grid = Grid::make('lines')
        ->editable()->rowsFrom('lines')->authorize(fn (): bool => true)
        ->minRows(1)
        ->columns([TextColumn::make('name')->maxLength(4)->rules(['max:4'])]);

    $rows = [['_k' => 'a', 'name' => 'Keep']];
    $applier = new OpApplier;

    // Structural: removing the only non-blank row below minRows → refusal + snapshot.
    $result = $applier->apply($grid, $rows, OpBatch::fromPayload(['ops' => [
        ['t' => 'remove', 'seq' => 1, 'row' => 'a'],
    ]]));
    expect($result->results[0]['ok'])->toBeFalse();
    expect($result->results[0]['rows'])->toBe($rows);

    // Cell-level: a validation error carries NO snapshot (error marks are the UX there).
    $result = $applier->apply($grid, $rows, OpBatch::fromPayload(['ops' => [
        ['t' => 'set', 'seq' => 2, 'row' => 'a', 'col' => 'name', 'v' => 'TooLongValue'],
    ]]));
    expect($result->results[0]['ok'])->toBeFalse();
    expect($result->results[0])->not->toHaveKey('rows');

    // Structural: a stale row reference also snapshots.
    $result = $applier->apply($grid, $rows, OpBatch::fromPayload(['ops' => [
        ['t' => 'set', 'seq' => 3, 'row' => 'ghost', 'col' => 'name', 'v' => 'x'],
    ]]));
    expect($result->results[0]['ok'])->toBeFalse();
    expect($result->results[0]['rows'])->toBe($rows);
});

it('dispatches lgrid:panel-done from the trait helper', function () {
    Livewire::test(EditableGridComponent::class)
        ->call('closePanel')
        ->assertDispatched('lgrid:panel-done', grid: 'lines');
});
