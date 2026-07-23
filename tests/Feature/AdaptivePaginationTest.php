<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Query\QueryPipeline;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\ExportItem;

/**
 * What: The adaptive single-page + deferred-mount contract (->singlePageUpTo, plan
 *       2026-07-20 — the 73k /items failure): the pipeline serves the WHOLE filtered set
 *       as one page whenever it fits the threshold (per request), and the serializer
 *       DEFERS the mount payload (zero rows + server.deferred) whenever page 1 would
 *       exceed laragrid.max_per_page — Livewire's HTML pipeline must never carry an
 *       oversized inline page again.
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

    foreach (range(1, 8) as $i) {
        ExportItem::create([
            'name' => sprintf('Item %02d', $i),
            'code' => null,
            'type' => 'goods',
            'qty' => $i,
            'rate' => '10.00',
            'active' => true,
            'booked_on' => null,
            'note' => null,
            'secret' => null,
        ]);
    }
});

function adaptiveGrid(?int $threshold, int $perPage = 3): Grid
{
    $grid = Grid::make('adaptive')
        ->query(fn () => ExportItem::query())
        ->authorize(fn (): bool => true)
        ->columns([
            TextColumn::make('name')->sortable(),
            IntegerColumn::make('qty'),
        ])
        ->paginate($perPage, [3, 100]);

    if ($threshold !== null) {
        $grid->singlePageUpTo($threshold);
    }

    return $grid;
}

it('serves the whole filtered set as ONE page when it fits the threshold', function () {
    $page = app(QueryPipeline::class)->run(adaptiveGrid(threshold: 50), []);

    expect($page->total)->toBe(8)
        ->and($page->perPage)->toBe(8)     // everything on page 1
        ->and($page->lastPage())->toBe(1)  // chrome self-hides client-side
        ->and($page->rows)->toHaveCount(8);
});

it('treats the threshold as inclusive (total == threshold → single page)', function () {
    $page = app(QueryPipeline::class)->run(adaptiveGrid(threshold: 8), []);

    expect($page->perPage)->toBe(8)->and($page->lastPage())->toBe(1);
});

it('falls back to the declared page size above the threshold', function () {
    $page = app(QueryPipeline::class)->run(adaptiveGrid(threshold: 5), []);

    expect($page->perPage)->toBe(3)
        ->and($page->rows)->toHaveCount(3)
        ->and($page->lastPage())->toBe(3);
});

it('decides per REQUEST: a narrowing search flips into single-page view', function () {
    $grid = adaptiveGrid(threshold: 5)->searchable(['name']);

    $page = app(QueryPipeline::class)->run($grid, ['search' => 'Item 0']);

    // 'Item 01'..'Item 08' all match 'Item 0' → 8 > 5 stays paginated; narrow further:
    $narrow = app(QueryPipeline::class)->run($grid, ['search' => 'Item 01']);

    expect($page->perPage)->toBe(3)
        ->and($narrow->total)->toBe(1)
        ->and($narrow->perPage)->toBe(1)
        ->and($narrow->lastPage())->toBe(1);
});

it('inlines the mount payload when page 1 fits under max_per_page', function () {
    config()->set('laragrid.max_per_page', 1000);

    $config = app(ConfigSerializer::class)->serialize(adaptiveGrid(threshold: 50));

    expect($config['rows'])->toHaveCount(8)
        ->and($config['server'])->not->toHaveKey('deferred');
});

it('DEFERS the mount payload when page 1 would exceed max_per_page', function () {
    config()->set('laragrid.max_per_page', 5); // 8 rows on one page > 5 → defer

    $config = app(ConfigSerializer::class)->serialize(adaptiveGrid(threshold: 50));

    expect($config['rows'])->toBe([])
        ->and($config['server']['deferred'])->toBeTrue()
        ->and($config['server']['total'])->toBe(8)
        ->and($config['server']['lastPage'])->toBe(1)
        // The deferred config still carries everything the client needs to boot.
        ->and($config['columns'])->not->toBeEmpty()
        ->and($config['layout']['serverSide'])->toBeTrue();
});

it('does not defer when the set is over the threshold and the page size is sane', function () {
    config()->set('laragrid.max_per_page', 5);

    $config = app(ConfigSerializer::class)->serialize(adaptiveGrid(threshold: 4, perPage: 3));

    expect($config['rows'])->toHaveCount(3)
        ->and($config['server'])->not->toHaveKey('deferred');
});

it('refuses an oversized page size WITHOUT the threshold chain at build time', function () {
    config()->set('laragrid.max_per_page', 1000);

    adaptiveGrid(threshold: null, perPage: 5000)->assertValid();
})->throws(InvalidArgumentException::class, 'max_per_page');

it('accepts the same oversized page size WITH the threshold chain (defer makes it safe)', function () {
    config()->set('laragrid.max_per_page', 1000);

    adaptiveGrid(threshold: 5000, perPage: 5000)->assertValid();

    expect(true)->toBeTrue();
});

it('refuses singlePageUpTo on a grid with no query()', function () {
    Grid::make('display')
        ->columns([TextColumn::make('name')])
        ->singlePageUpTo(100)
        ->assertValid();
})->throws(InvalidArgumentException::class, 'no query()');
