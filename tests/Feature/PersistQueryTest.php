<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Query\QueryStore;
use LaraGrid\Query\SessionQueryStore;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\ExportItem;
use LaraGrid\Tests\Hosts\ServerGridComponent;

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

    ExportItem::create(['name' => 'Anvil', 'type' => 'service', 'qty' => 4]);
    ExportItem::create(['name' => 'Bolt', 'type' => 'goods', 'qty' => 10]);
    ExportItem::create(['name' => 'Crate', 'type' => 'service', 'qty' => 7]);
});

/** A host with ->persistQuery() declared. */
function persistHost(?string $key = null): ServerGridComponent
{
    $host = new ServerGridComponent;
    $host->persist = true;
    $host->persistKey = $key;

    return $host;
}

/** The store as the package resolves it. */
function queryStore(): QueryStore
{
    return app(QueryStore::class);
}

// ---- Build-time declaration ------------------------------------------------------------------

it('rejects persistQuery() on a grid without query() at build time', function () {
    $grid = Grid::make('d')->columns([TextColumn::make('n')])->persistQuery();

    expect(fn () => $grid->assertValid())
        ->toThrow(InvalidArgumentException::class, 'query persistence needs a server-side readonly grid');
});

it('rejects the reserved and unknown persistence modes', function () {
    expect(fn () => Grid::make('d')->persistQuery('local'))
        ->toThrow(InvalidArgumentException::class, 'is reserved and not implemented');
    expect(fn () => Grid::make('d')->persistQuery('url'))
        ->toThrow(InvalidArgumentException::class, 'is reserved and not implemented');
    expect(fn () => Grid::make('d')->persistQuery('server'))
        ->toThrow(InvalidArgumentException::class, 'is reserved and not implemented');
    expect(fn () => Grid::make('d')->persistQuery('elsewhere'))
        ->toThrow(InvalidArgumentException::class, 'unknown persistQuery mode');
});

// ---- The write path (gridFetch) ---------------------------------------------------------------

it('stores the sanitized query after a fetch, without the page number', function () {
    $host = persistHost();

    $host->gridFetch('items', [
        'sort' => 'qty',
        'dir' => 'desc',
        'search' => 'bol',
        'filters' => ['type' => 'goods'],
        'page' => 2,
        'perPage' => 5,
    ]);

    expect(queryStore()->get('items'))->toBe([
        'search' => 'bol',
        'sort' => 'qty',
        'dir' => 'desc',
        'filters' => ['type' => 'goods'],
        'perPage' => 5,
    ]);
});

it('namespaces the entry in the session under the grid key', function () {
    persistHost()->gridFetch('items', ['filters' => ['type' => 'goods']]);

    expect(session()->get(SessionQueryStore::PREFIX.'items'))->toBeArray()
        ->and(session()->get(SessionQueryStore::PREFIX.'items')['filters'])->toBe(['type' => 'goods']);
});

it('honours a storage key override', function () {
    persistHost('items:c7')->gridFetch('items', ['filters' => ['type' => 'goods']]);

    expect(queryStore()->get('items:c7'))->not->toBe([]);
    expect(queryStore()->get('items'))->toBe([]);
});

it('forgets the entry when the operator is back on the grid defaults', function () {
    $host = persistHost();

    $host->gridFetch('items', ['filters' => ['type' => 'goods']]);
    expect(queryStore()->get('items'))->not->toBe([]);

    // Every control cleared → the declared default state → no session footprint at all.
    $host->gridFetch('items', ['sort' => 'name', 'dir' => 'asc', 'search' => '', 'filters' => [], 'perPage' => 2]);
    expect(queryStore()->get('items'))->toBe([]);
});

it('never touches the store for a grid that does not declare persistQuery()', function () {
    $host = new ServerGridComponent;

    $host->gridFetch('items', ['filters' => ['type' => 'goods'], 'search' => 'bol']);

    expect(queryStore()->get('items'))->toBe([]);
});

it('drops unknown filter keys, stale option values and an unoffered perPage', function () {
    persistHost()->gridFetch('items', [
        'sort' => 'ghost_column',
        'search' => str_repeat('x', 500),
        'filters' => [
            'type' => 'goods',
            'evil' => '1; DROP TABLE',   // not a declared filter
        ],
        'perPage' => 9999,               // not one of the declared options
    ]);

    expect(queryStore()->get('items'))->toBe([
        'search' => str_repeat('x', 200),
        'sort' => null,
        'dir' => 'asc',
        'filters' => ['type' => 'goods'],
        'perPage' => 2,
    ]);
});

it('drops a filter value the filter no longer offers', function () {
    // 'ghost' is not one of the SelectFilter's options — the shape is fine, the value is stale
    // (the tenant switched, or the referenced record is gone). It must never reach a WHERE.
    persistHost()->gridFetch('items', ['filters' => ['type' => 'ghost']]);

    expect(queryStore()->get('items'))->toBe([]);
});

it('clears the entry through forgetGridQuery()', function () {
    $host = persistHost();
    $host->gridFetch('items', ['filters' => ['type' => 'goods']]);

    $host->forgetGridQuery('items');

    expect(queryStore()->get('items'))->toBe([]);
});

// ---- The read path (config) --------------------------------------------------------------------

it('omits config.query for a grid that does not declare persistQuery()', function () {
    $config = app(ConfigSerializer::class)->serialize((new ServerGridComponent)->gridDefinition('items'));

    expect($config)->not->toHaveKey('query');
});

it('emits config.query from the declared defaults when nothing is stored', function () {
    $config = app(ConfigSerializer::class)->serialize(persistHost()->gridDefinition('items'));

    expect($config['query'])->toBe([
        'search' => '',
        'sort' => 'name',
        'dir' => 'asc',
        'filters' => [],
        'perPage' => 2,
    ]);
});

it('builds page 1 already narrowed by the stored query — no unfiltered first paint', function () {
    queryStore()->put('items', [
        'search' => '',
        'sort' => 'name',
        'dir' => 'asc',
        'filters' => ['type' => 'service'],
        'perPage' => 5,
    ]);

    $config = app(ConfigSerializer::class)->serialize(persistHost()->gridDefinition('items'));

    expect($config['query']['filters'])->toBe(['type' => 'service']);
    expect($config['server']['total'])->toBe(2);
    expect(array_column($config['rows'], 'name'))->toBe(['Anvil', 'Crate']);
});

it('replays a stored sort and per-page into the first page', function () {
    queryStore()->put('items', [
        'search' => '',
        'sort' => 'qty',
        'dir' => 'desc',
        'filters' => [],
        'perPage' => 5,
    ]);

    $config = app(ConfigSerializer::class)->serialize(persistHost()->gridDefinition('items'));

    expect($config['server']['perPage'])->toBe(5);
    expect(array_column($config['rows'], 'name'))->toBe(['Bolt', 'Crate', 'Anvil']);
});

it('falls back to the declared sort when the stored column is gone', function () {
    queryStore()->put('items', [
        'search' => '',
        'sort' => 'a_column_that_was_removed',
        'dir' => 'desc',
        'filters' => [],
        'perPage' => 2,
    ]);

    $config = app(ConfigSerializer::class)->serialize(persistHost()->gridDefinition('items'));

    expect($config['query']['sort'])->toBe('name');
    expect($config['query']['dir'])->toBe('asc');
});

it('counts the NARROWED set when deciding the deferred initial load', function () {
    config()->set('laragrid.max_per_page', 1);

    queryStore()->put('items', [
        'search' => '',
        'sort' => 'name',
        'dir' => 'asc',
        'filters' => ['type' => 'service'],
        'perPage' => 2,
    ]);

    $host = persistHost();
    $host->singlePageUpTo = 1;

    $config = app(ConfigSerializer::class)->serialize($host->gridDefinition('items'));

    // Deferred (perPage 2 > cap 1) — and the advertised total is the FILTERED one, so the
    // client's boot fetch inherits the narrowing rather than re-deciding it.
    expect($config['server']['deferred'])->toBeTrue();
    expect($config['server']['total'])->toBe(2);
    expect($config['query']['filters'])->toBe(['type' => 'service']);
});
