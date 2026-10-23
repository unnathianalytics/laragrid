<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use LaraGrid\Aggregate;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Query\QueryPipeline;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\ExportItem;
use LaraGrid\Tests\Hosts\ServerGridComponent;

/**
 * What: The query budget of the readonly data path (performance plan P2): one combined
 *       COUNT + SUMs statement per page, no ORDER BY on any aggregate, the adaptive pre-count
 *       handed into the pipeline instead of being run twice, and the grouped/distinct fallback
 *       that keeps Laravel's own per-query semantics.
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
        ExportItem::create(['name' => sprintf('Item %02d', $i), 'type' => 'goods', 'qty' => $i, 'rate' => '10.00']);
    }

    DB::enableQueryLog();
});

/** The SQL of every query run since the last flush. */
function loggedSql(): array
{
    return array_map(fn (array $entry): string => strtolower($entry['query']), DB::getQueryLog());
}

/** A two-sum server grid over an arbitrary host query. */
function aggregateGrid(Closure $query, ?int $threshold = null): Grid
{
    $grid = Grid::make('agg')
        ->query($query)
        ->authorize(fn (): bool => true)
        ->columns([
            TextColumn::make('name')->sortable(),
            IntegerColumn::make('qty')->sortable(),
            DecimalColumn::make('rate')->scale(2),
        ])
        ->footer([Aggregate::sum('qty'), Aggregate::sum('rate')])
        ->defaultSort('name')
        ->paginate(3, [3, 100]);

    if ($threshold !== null) {
        $grid->singlePageUpTo($threshold);
    }

    return $grid;
}

it('runs exactly two queries per gridFetch on a grid with two footer sums', function () {
    $host = new ServerGridComponent;
    DB::flushQueryLog();

    $page = $host->gridFetch('items', ['sort' => 'qty', 'dir' => 'desc']);

    $sql = loggedSql();
    expect($sql)->toHaveCount(2)
        ->and($sql[0])->toContain('count(*) as lg_total')
        ->and($sql[0])->toContain('sum("qty") as lg_sum_0')
        ->and($sql[0])->toContain('sum("rate") as lg_sum_1')
        ->and($sql[1])->toContain('order by "qty" desc')
        ->and($page['total'])->toBe(8)
        ->and($page['grandTotals'])->toBe(['qty' => 36, 'rate' => 80]);
});

it('carries no ORDER BY on any aggregate, on the combined and the fallback path alike', function () {
    DB::flushQueryLog();
    app(QueryPipeline::class)->run(aggregateGrid(fn () => ExportItem::query()->orderBy('rate')), ['sort' => 'qty']);
    app(QueryPipeline::class)->run(aggregateGrid(fn () => ExportItem::query()->groupBy('type')), ['sort' => 'qty']);

    $aggregates = array_filter(loggedSql(), fn (string $sql): bool => str_contains($sql, 'sum(') || str_contains($sql, 'count('));

    expect($aggregates)->toHaveCount(4) // one combined, then one COUNT + two SUMs
        ->and($aggregates)->each->not->toContain('order by');
});

it('falls back to COUNT + one SUM per column on a grouped host query, with the same totals', function () {
    $grid = aggregateGrid(fn () => ExportItem::query()->groupBy('type'));
    DB::flushQueryLog();

    $page = app(QueryPipeline::class)->run($grid, []);

    $sql = loggedSql();
    expect($sql)->toHaveCount(4) // COUNT, SUM, SUM, page SELECT
        ->and(implode(' ', $sql))->not->toContain('lg_total')
        ->and($page->total)->toBe(ExportItem::query()->groupBy('type')->toBase()->getCountForPagination())
        ->and($page->grandTotals)->toBe([
            'qty' => (int) ExportItem::query()->groupBy('type')->sum('qty'),
            'rate' => (int) ExportItem::query()->groupBy('type')->sum('rate'),
        ]);
});

it('keeps a host select() list out of the combined aggregate', function () {
    $grid = aggregateGrid(fn () => ExportItem::query()->select('id', 'name', 'qty', 'rate'));
    DB::flushQueryLog();

    $page = app(QueryPipeline::class)->run($grid, []);

    expect(loggedSql()[0])->toStartWith('select count(*) as lg_total, sum("qty") as lg_sum_0, sum("rate") as lg_sum_1 from "export_items"')
        ->and($page->grandTotals)->toBe(['qty' => 36, 'rate' => 80])
        ->and($page->rows)->toHaveCount(3);
});

it('sums only the filtered set and keeps integer totals as integers', function () {
    $grid = aggregateGrid(fn () => ExportItem::query())->searchable(['name']);

    $page = app(QueryPipeline::class)->run($grid, ['search' => 'Item 0']); // Item 01..08 minus nothing

    expect($page->total)->toBe(8)->and($page->grandTotals['qty'])->toBe(36);

    $narrow = app(QueryPipeline::class)->run($grid, ['search' => 'Item 08']);

    expect($narrow->total)->toBe(1)
        ->and($narrow->grandTotals)->toBe(['qty' => 8, 'rate' => 10])
        ->and($narrow->grandTotals['qty'])->toBeInt();
});

it('never counts twice on a singlePageUpTo() mount: the pre-count is handed to the pipeline', function () {
    // No footer sums: pre-count + page SELECT only.
    $plain = Grid::make('plain')
        ->query(fn () => ExportItem::query())
        ->authorize(fn (): bool => true)
        ->columns([TextColumn::make('name')])
        ->paginate(3, [3, 100])
        ->singlePageUpTo(50);
    DB::flushQueryLog();

    $config = app(ConfigSerializer::class)->serialize($plain);

    expect(loggedSql())->toHaveCount(2)
        ->and($config['rows'])->toHaveCount(8)
        ->and($config['server']['total'])->toBe(8);

    // With footer sums the SUMs still need one statement: pre-count + aggregate + page SELECT.
    DB::flushQueryLog();

    $config = app(ConfigSerializer::class)->serialize(aggregateGrid(fn () => ExportItem::query(), threshold: 50));

    $sql = loggedSql();
    expect($sql)->toHaveCount(3)
        ->and(array_filter($sql, fn (string $s): bool => str_contains($s, 'count(')))->toHaveCount(2)
        ->and($config['server']['grandTotals'])->toBe(['qty' => 36, 'rate' => 80]);
});

it('runs exactly two queries for a plain paginated mount', function () {
    DB::flushQueryLog();

    $config = app(ConfigSerializer::class)->serialize(aggregateGrid(fn () => ExportItem::query()));

    expect(loggedSql())->toHaveCount(2)
        ->and($config['rows'])->toHaveCount(3)
        ->and($config['footer'][0]['value'])->toBe(36);
});
