<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use LaraGrid\Tests\Hosts\DisplayGridComponent;
use LaraGrid\Tests\Hosts\EditableGridComponent;
use LaraGrid\Tests\Hosts\ExportItem;
use LaraGrid\Tests\Hosts\ServerGridComponent;
use LaraGrid\Tests\Hosts\ToggleGridComponent;
use Livewire\Features\SupportLockedProperties\CannotUpdateLockedPropertyException;
use Livewire\Features\SupportTesting\Testable;
use Livewire\Livewire;

/**
 * What: The "skip the discarded config payload" contract (perf plan P1). The grid body sits
 *       inside wire:ignore, so after the first paint the browser never reads the inline config
 *       again; a host update that re-renders must therefore ship a SHELL (no rows, no queries)
 *       for every grid the browser already mounted — and the FULL payload for any grid the
 *       browser does not hold yet (first render, a grid appearing after an @if flip, a plain
 *       Blade page). A late remount recovers its rows through server.deferred (query grids) or
 *       the gridReseedRows RPC (editable rowsFrom() grids). Display grids always ship whole:
 *       their rows come from the Blade view, which nothing could replay.
 */
beforeEach(function () {
    Schema::create('export_items', function (Blueprint $table) {
        $table->id();
        $table->string('name');
        $table->string('code')->nullable();
        $table->string('type', 20)->nullable();
        $table->integer('qty')->default(0);
        $table->decimal('rate', 10, 2)->nullable();
        $table->boolean('active')->default(true);
        $table->date('booked_on')->nullable();
        $table->string('note')->nullable();
        $table->string('secret')->nullable();
        $table->timestamps();
    });

    foreach (range(1, 4) as $i) {
        ExportItem::create(['name' => "Item {$i}", 'type' => 'goods', 'qty' => $i, 'rate' => '10.00', 'active' => true]);
    }
});

/**
 * Every embedded config block in a rendered page, keyed by grid name.
 *
 * @return array<string, array<string, mixed>>
 */
function embeddedConfigs(string $html): array
{
    preg_match_all('/data-lgrid-config>(.*?)<\/script>/s', $html, $matches);
    $configs = [];
    foreach ($matches[1] as $json) {
        $config = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        $configs[$config['name']] = $config;
    }

    return $configs;
}

/** The value the last call() returned (Livewire exposes it only through assertReturned). */
function rpcReturn(Testable $component): mixed
{
    $captured = null;
    $component->assertReturned(function ($value) use (&$captured): bool {
        $captured = $value;

        return true;
    });

    return $captured;
}

it('ships the full payload on the first render and a rowsDeferred shell on a later host render', function () {
    $component = Livewire::test(EditableGridComponent::class);

    $first = embeddedConfigs($component->html())['lines'];
    expect($first['rows'])->toHaveCount(2)
        ->and($first)->not->toHaveKey('rowsDeferred');

    $component->call('$refresh');

    $again = embeddedConfigs($component->html())['lines'];
    expect($again['rows'])->toBe([])
        ->and($again['rowsDeferred'])->toBeTrue()
        ->and($again['footer'])->toBe($first['footer']) // no footer declared: empty both times
        ->and($again['columns'])->toBe($first['columns'])
        ->and($again['layout'])->toBe($first['layout']);
});

it('runs zero grid queries when a server-side host re-renders after mount', function () {
    $component = Livewire::test(ServerGridComponent::class);
    expect(embeddedConfigs($component->html())['items']['rows'])->toHaveCount(2);

    DB::enableQueryLog();
    $component->call('$refresh');
    $queries = array_filter(DB::getQueryLog(), fn (array $q): bool => str_contains($q['query'], 'export_items'));
    DB::disableQueryLog();

    expect($queries)->toBe([]);

    $shell = embeddedConfigs($component->html())['items'];
    expect($shell['rows'])->toBe([])
        ->and($shell['server']['deferred'])->toBeTrue()
        ->and($shell['server']['perPage'])->toBe(2)
        ->and($shell['filters'])->not->toBeEmpty(); // the shell still carries everything a remount needs
});

it('gives a grid that first appears after an update the full payload, and again after it leaves and returns', function () {
    $component = Livewire::test(ToggleGridComponent::class);
    expect(embeddedConfigs($component->html()))->not->toHaveKey('lines');

    $component->set('show', true);
    $configs = embeddedConfigs($component->html());
    expect($configs['lines']['rows'])->toHaveCount(2)
        ->and($configs['lines'])->not->toHaveKey('rowsDeferred')
        // The sibling DISPLAY grid was mounted by the first render, but a display grid's rows
        // come from the Blade view, which nothing could replay — it always ships whole.
        ->and($configs['taxes']['rows'])->toHaveCount(2)
        ->and($configs['taxes'])->not->toHaveKey('rowsDeferred');

    $component->call('$refresh');
    expect(embeddedConfigs($component->html())['lines']['rowsDeferred'])->toBeTrue();

    $component->set('show', false);
    expect(embeddedConfigs($component->html()))->not->toHaveKey('lines');

    $component->set('show', true);
    $back = embeddedConfigs($component->html())['lines'];
    expect($back['rows'])->toHaveCount(2)->and($back)->not->toHaveKey('rowsDeferred');
});

it('keeps the full payload for a display grid with no rowsFrom() — nothing could reseed it later', function () {
    $component = Livewire::test(DisplayGridComponent::class);
    $component->call('$refresh');

    $config = embeddedConfigs($component->html())['taxes'];
    expect($config['rows'])->toHaveCount(2)->and($config)->not->toHaveKey('rowsDeferred');
});

it('reseeds an editable grid through gridReseedRows for a late remount, at its current version', function () {
    $component = Livewire::test(ToggleGridComponent::class);

    $before = rpcReturn($component->call('gridReseedRows', 'lines'));
    expect($before['rows'])->toHaveCount(2)
        ->and($before['rows'][0])->toHaveKey('_k')
        ->and($before['footer'])->toBe(['amount' => 0])
        ->and($before['version'])->toBe(0);

    // An applied op moves the server version; the reseed must hand the CURRENT one back, so the
    // remounted client's next batch is not refused as stale.
    $key = $before['rows'][0]['_k'];
    $component->call('gridOps', 'lines', ['baseVersion' => 0, 'ops' => [
        ['t' => 'set', 'seq' => 1, 'row' => $key, 'col' => 'amount', 'v' => '12.50'],
    ]]);

    $after = rpcReturn($component->call('gridReseedRows', 'lines'));
    expect($after['version'])->toBe(1)
        ->and($after['rows'][0]['amount'])->toEqual(12.5)
        ->and($after['footer']['amount'])->toEqual(12.5);
});

it('refuses gridReseedRows for a server-side grid and for a display grid, even one bound with rowsFrom()', function () {
    expect(fn () => Livewire::test(ServerGridComponent::class)->call('gridReseedRows', 'items'))
        ->toThrow(InvalidArgumentException::class, 'gridFetch');

    expect(fn () => Livewire::test(DisplayGridComponent::class)->call('gridReseedRows', 'taxes'))
        ->toThrow(InvalidArgumentException::class, 'editable rowsFrom()');

    expect(fn () => Livewire::test(ToggleGridComponent::class)->call('gridReseedRows', 'taxes'))
        ->toThrow(InvalidArgumentException::class, 'editable rowsFrom()');
});

it('gives a stray client call to the render hooks no way to shell an unmounted grid', function () {
    $component = Livewire::test(ToggleGridComponent::class);

    // Hooks are public (Livewire requires it), so a client can call them as actions.
    $component->call('renderedWithLaraGrid')->call('renderingWithLaraGrid');
    $component->set('show', true);

    $lines = embeddedConfigs($component->html())['lines'];
    expect($lines['rows'])->toHaveCount(2)->and($lines)->not->toHaveKey('rowsDeferred');
});

it('locks the mounted-grid set against client tampering', function () {
    Livewire::test(EditableGridComponent::class)->set('laraGridMounted', []);
})->throws(CannotUpdateLockedPropertyException::class);
