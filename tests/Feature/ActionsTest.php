<?php

declare(strict_types=1);

use Illuminate\Auth\Access\AuthorizationException;
use LaraGrid\Actions\Action;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\ActionsGridComponent;
use Livewire\Livewire;

it('serializes action meta, synthetic columns and per-row action bags', function () {
    $config = null;
    Livewire::test(ActionsGridComponent::class)->tap(function ($test) use (&$config) {
        $component = $test->instance();
        $config = app(ConfigSerializer::class)->serialize(
            $component->gridDefinition('items'),
            $component->lines,
        );
    });

    // Meta: labels/kind/confirm, never closures.
    expect($config['actions']['row'])->toHaveCount(4);
    expect($config['actions']['row'][1])
        ->toMatchArray(['name' => 'zap', 'kind' => 'call', 'confirm' => 'Zap this row?']);
    expect($config['actions']['toolbar'][1])
        ->toMatchArray(['name' => 'create', 'kind' => 'url', 'url' => '/items/create']);

    // Synthetic columns: leading _select (bulk declared), trailing _actions.
    $keys = array_column($config['columns'], 'key');
    expect($keys[0])->toBe('_select');
    expect(end($keys))->toBe('_actions');

    // Row bags: url resolved per row (locked row → edit omitted); call visibility applied.
    $rows = $config['rows'];
    expect($rows[0]['_actions'])->toMatchArray(['edit' => '/items/a/edit', 'zap' => true]);
    expect($rows[1]['_actions'] ?? [])->not->toHaveKey('edit'); // locked → url resolver returned null
    expect($rows[1]['_actions'] ?? [])->not->toHaveKey('zap');  // locked → visible() false
});

it('runs a row call action and returns the reseed payload', function () {
    Livewire::test(ActionsGridComponent::class)
        ->call('gridAction', 'items', 'zap', ['a'])
        ->tap(function ($test) {
            expect($test->get('lines')[0]['name'])->toBe('ZAPPED');

            $response = $test->instance()->gridAction('items', 'ping'); // toolbar scope reuse below
            expect($response['ok'])->toBeTrue();
        });
});

it('re-checks per-row visibility on call — a hidden action is an unusable action', function () {
    Livewire::test(ActionsGridComponent::class)
        ->call('gridAction', 'items', 'zap', ['b'])
        ->assertStatus(403); // row b is locked → visible() false → authorization exception
});

it('refuses to call a url action', function () {
    (new ActionsGridComponent)->gridAction('items', 'edit', ['a']);
})->throws(InvalidArgumentException::class, 'url action');

it('throws for an unknown action name', function () {
    (new ActionsGridComponent)->gridAction('items', 'phantom');
})->throws(InvalidArgumentException::class, 'no action named [phantom]');

it('enforces the per-action authorize gate', function () {
    (new ActionsGridComponent)->gridAction('items', 'guarded', ['a']);
})->throws(AuthorizationException::class, 'Denied.');

it('turns a ValidationException into an operator-facing refusal', function () {
    $response = (new ActionsGridComponent)->gridAction('items', 'refuse', ['a']);

    expect($response['ok'])->toBeFalse();
    expect($response['message'])->toContain('Cannot do that');
});

it('runs bulk actions over the checked keys', function () {
    Livewire::test(ActionsGridComponent::class)
        ->call('gridAction', 'items', 'purge', ['a', 'b'])
        ->tap(fn ($test) => expect($test->get('lines'))->toHaveCount(0));
});

it('runs toolbar actions with no row context', function () {
    Livewire::test(ActionsGridComponent::class)
        ->call('gridAction', 'items', 'ping')
        ->assertSet('pinged', true);
});

it('reports a stale row target as a refusal, not a crash', function () {
    $response = (new ActionsGridComponent)->gridAction('items', 'zap', ['ghost']);

    expect($response)->toMatchArray(['ok' => false, 'message' => 'That row no longer exists.']);
});

it('rejects duplicate action names and call actions on display grids at build time', function () {
    $dupes = Grid::make('d')->columns([TextColumn::make('n')])
        ->editable()->rowsFrom('x')->authorize(fn (): bool => true)
        ->actions([Action::make('a')->url(fn () => '/x')])
        ->toolbarActions([Action::make('a')->call(fn () => null)]);
    expect(fn () => $dupes->assertValid())
        ->toThrow(InvalidArgumentException::class, 'duplicate action name');

    $displayCall = Grid::make('d2')->columns([TextColumn::make('n')])
        ->actions([Action::make('boom')->call(fn () => null)]);
    expect(fn () => $displayCall->assertValid())
        ->toThrow(InvalidArgumentException::class, 'editable or query() grid');
});
