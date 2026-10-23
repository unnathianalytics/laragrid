<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use LaraGrid\Actions\Action;
use LaraGrid\Columns\ComputedColumn;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Export\ExportBuilder;
use LaraGrid\Grid;
use LaraGrid\Query\AppliesEagerLoads;
use LaraGrid\Query\QueryPipeline;
use LaraGrid\Support\RowSerializer;
use LaraGrid\Tests\Hosts\CountingItem;
use LaraGrid\Tests\Hosts\ItemGroup;
use LaraGrid\Tests\Hosts\RelatedItem;

/**
 * What: The row-shaping budget of performance plan P6: one toArray() per serialized or exported
 *       row, however many closures read it, and one query per relation behind dot-keyed columns
 *       instead of one per row, without overriding what the host query already loads and
 *       without treating a JSON attribute path as a relation.
 */
beforeEach(function () {
    Schema::create('item_groups', function (Blueprint $table) {
        $table->id();
        $table->string('name');
        $table->foreignId('parent_id')->nullable();
        $table->text('meta')->nullable();
        $table->timestamps();
    });

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
        $table->foreignId('group_id')->nullable();
        $table->text('meta')->nullable();
        $table->timestamps();
    });

    $root = ItemGroup::create(['name' => 'Root']);

    // 25 items, each in its own group, so a lazy relation costs one query per row.
    foreach (range(1, 25) as $i) {
        $group = ItemGroup::create(['name' => sprintf('Group %02d', $i), 'parent_id' => $root->id, 'meta' => ['color' => 'teal']]);
        RelatedItem::create([
            'name' => sprintf('Item %02d', $i),
            'qty' => $i,
            'group_id' => $group->id,
            'meta' => ['color' => $i % 2 === 0 ? 'red' : 'blue'],
        ]);
    }

    CountingItem::$toArrayCalls = 0;
});

/** A 20-row-per-page server grid over $query with the given extra columns. */
function relationGrid(Closure $query, array $columns): Grid
{
    return Grid::make('related')
        ->query($query)
        ->authorize(fn (): bool => true)
        ->paginate(20, [20])
        ->defaultSort('name')
        ->columns([
            TextColumn::make('name')->sortable(),
            ...$columns,
        ]);
}

/** Run one page through the pipeline and return [rows, the SQL it ran]. */
function relationPage(Grid $grid): array
{
    DB::flushQueryLog();
    DB::enableQueryLog();
    $rows = (new QueryPipeline)->run($grid, [])->rows;
    $sql = array_map(fn (array $entry): string => strtolower($entry['query']), DB::getQueryLog());
    DB::disableQueryLog();

    return [$rows, $sql];
}

// ---- One array view per row -------------------------------------------------------------------

it('converts a model to an array once per row, whatever reads it', function () {
    $grid = Grid::make('counting')
        ->query(fn () => CountingItem::query())
        ->authorize(fn (): bool => true)
        ->columns([
            TextColumn::make('name'),
            IntegerColumn::make('qty'),
            ComputedColumn::make('double')->state(fn (array $row): int => $row['qty'] * 2),
            ComputedColumn::make('label')->state(fn (array $row): string => strtoupper($row['name'])),
        ])
        ->actions([
            Action::make('edit')->url(fn (array $row): string => '/items/'.$row['id'].'/edit'),
        ])
        ->rowClass(fn (array $row): ?string => $row['qty'] > 2 ? 'big' : null)
        ->rowActivate(fn (array $row): string => '/items/'.$row['id']);

    $model = CountingItem::query()->where('name', 'Item 03')->firstOrFail();
    CountingItem::$toArrayCalls = 0;

    $row = (new RowSerializer)->serializeMany($grid, [$model])[0];

    expect(CountingItem::$toArrayCalls)->toBe(1);
    expect($row['double'])->toBe(6);
    expect($row['label'])->toBe('ITEM 03');
    expect($row['_actions'])->toBe(['edit' => '/items/'.$model->id.'/edit']);
    expect($row['_rowClass'])->toBe('big');
    expect($row['_activateUrl'])->toBe('/items/'.$model->id);
});

it('converts each exported row to an array once, and only when a computed column needs it', function () {
    $columns = [
        TextColumn::make('name'),
        ComputedColumn::make('double')->state(fn (array $row): int => $row['qty'] * 2),
        ComputedColumn::make('label')->state(fn (array $row): string => strtoupper($row['name'])),
    ];
    $grid = Grid::make('counting')->query(fn () => CountingItem::query())->columns($columns);

    $rows = iterator_to_array((new ExportBuilder)->build($grid, [])->rows, false);

    expect($rows)->toHaveCount(25);
    expect($rows[2])->toBe(['Item 03', '6', 'ITEM 03']);
    expect(CountingItem::$toArrayCalls)->toBe(25);

    CountingItem::$toArrayCalls = 0;
    $plain = Grid::make('plain')->query(fn () => CountingItem::query())->columns([TextColumn::make('name')]);
    iterator_to_array((new ExportBuilder)->build($plain, [])->rows, false);

    expect(CountingItem::$toArrayCalls)->toBe(0);
});

// ---- Eager loading for dot-keyed columns ------------------------------------------------------

it('loads a relation column for a page of 20 rows in three queries, not 22', function () {
    $grid = relationGrid(fn () => RelatedItem::query(), [TextColumn::make('group.name')]);

    [$rows, $sql] = relationPage($grid);

    expect($rows)->toHaveCount(20);
    expect($rows[0]['group.name'])->toBe('Group 01');
    expect($rows[19]['group.name'])->toBe('Group 20');

    expect($sql)->toHaveCount(3);
    expect($sql[0])->toContain('count(*)');
    expect($sql[1])->toContain('from "export_items"');
    expect($sql[2])->toContain('from "item_groups"')->toContain(' in (');

    // The same 20 models serialized without the eager load: one relation query per row.
    DB::flushQueryLog();
    DB::enableQueryLog();
    (new RowSerializer)->serializeMany($grid, RelatedItem::query()->orderBy('name')->limit(20)->get());
    expect(DB::getQueryLog())->toHaveCount(21);
    DB::disableQueryLog();
});

it('leaves a JSON attribute path alone: no eager load, still resolved through data_get', function () {
    $grid = relationGrid(fn () => RelatedItem::query(), [TextColumn::make('meta.color')]);

    $query = RelatedItem::query();
    expect((new AppliesEagerLoads)->apply($query, $grid))->toBe([]);
    expect($query->getEagerLoads())->toBe([]);

    [$rows, $sql] = relationPage($grid);

    expect($sql)->toHaveCount(2); // count + page, nothing else
    expect($rows[0]['meta.color'])->toBe('blue');
    expect($rows[1]['meta.color'])->toBe('red');
});

it('adds nothing when the host query already eager-loads the relation, and keeps its constraint', function () {
    $grid = relationGrid(
        fn () => RelatedItem::query()->with(['group' => fn ($query) => $query->select('id', 'name')]),
        [TextColumn::make('group.name')],
    );

    $query = $grid->resolveQuery();
    $hostEntry = $query->getEagerLoads()['group'];
    expect((new AppliesEagerLoads)->apply($query, $grid))->toBe([]);
    expect($query->getEagerLoads())->toBe(['group' => $hostEntry]);

    [$rows, $sql] = relationPage($grid);

    expect($sql)->toHaveCount(3);
    expect($sql[2])->toContain('select "id", "name" from "item_groups"');
    expect($rows[4]['group.name'])->toBe('Group 05');
});

it('adds nothing when the host loads the relation as part of a deeper path', function () {
    $grid = relationGrid(fn () => RelatedItem::query()->with('group.parent'), [TextColumn::make('group.name')]);

    $query = $grid->resolveQuery();
    expect((new AppliesEagerLoads)->apply($query, $grid))->toBe([]);
});

it('adds a nested path under a host-constrained relation without replacing the constraint', function () {
    // Eloquent's own with('group.parent') would reset the host's 'group' entry to an empty
    // constraint; the groups query below proves the host's column list survived.
    $grid = relationGrid(
        fn () => RelatedItem::query()->with(['group' => fn ($query) => $query->select('id', 'name', 'parent_id')]),
        [TextColumn::make('group.parent.name')],
    );

    $query = $grid->resolveQuery();
    $hostEntry = $query->getEagerLoads()['group'];
    expect((new AppliesEagerLoads)->apply($query, $grid))->toBe(['group.parent']);
    expect($query->getEagerLoads()['group'])->toBe($hostEntry);

    [$rows, $sql] = relationPage($grid);

    expect($sql)->toHaveCount(4); // count, page, groups, parents
    expect($sql[2])->toContain('select "id", "name", "parent_id" from "item_groups"');
    expect($rows[0]['group.parent.name'])->toBe('Root');
});

it('loads only the relation part of a path that ends in a JSON attribute of the related model', function () {
    $grid = relationGrid(fn () => RelatedItem::query(), [TextColumn::make('group.meta.color')]);

    $query = $grid->resolveQuery();
    expect((new AppliesEagerLoads)->apply($query, $grid))->toBe(['group']);

    [$rows, $sql] = relationPage($grid);

    expect($sql)->toHaveCount(3);
    expect($rows[0]['group.meta.color'])->toBe('teal');
});

it('serves the page on the lazy path when an added eager load throws', function () {
    $grid = relationGrid(fn () => RelatedItem::query(), [TextColumn::make('fragileGroup.name')]);

    [$rows, $sql] = relationPage($grid);

    expect($rows)->toHaveCount(20);
    expect($rows[0]['fragileGroup.name'])->toBe('Group 01');
    expect($rows[19]['fragileGroup.name'])->toBe('Group 20');
    // count, the page that failed during its eager load, the page again, one group per row.
    expect($sql)->toHaveCount(3 + 20);
});

it('eager-loads relation columns per export chunk, and falls back the same way', function () {
    config(['laragrid.export.chunk' => 10]); // floored to 50; 25 rows fit in one chunk
    $grid = relationGrid(fn () => RelatedItem::query(), [TextColumn::make('group.name')]);

    DB::flushQueryLog();
    DB::enableQueryLog();
    $rows = iterator_to_array((new ExportBuilder)->build($grid, [])->rows, false);
    $queries = count(DB::getQueryLog());
    DB::disableQueryLog();

    expect($rows)->toHaveCount(25);
    expect($rows[24])->toBe(['Item 25', 'Group 25']);
    expect($queries)->toBe(2); // the chunk + its groups

    $fragile = relationGrid(fn () => RelatedItem::query(), [TextColumn::make('fragileGroup.name')]);
    $rows = iterator_to_array((new ExportBuilder)->build($fragile, [])->rows, false);

    expect(array_column($rows, 1))->toBe(array_map(fn (int $i): string => sprintf('Group %02d', $i), range(1, 25)));
});
