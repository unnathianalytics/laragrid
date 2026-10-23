<?php

declare(strict_types=1);

use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use LaraGrid\Views\DatabaseViewStore;

/**
 * What: DatabaseViewStore::save()'s query budget and overwrite semantics (performance plan P7):
 *       one upsert on the (scope, grid_key, name) unique index plus one id lookup, for a new view
 *       and for an overwrite alike; an overwrite keeps the row's id and created_at.
 */
beforeEach(function () {
    $migration = require dirname(__DIR__, 2).'/database/migrations/2026_07_16_000001_create_laragrid_views_table.php';
    $migration->up();
});

/** Save through the store and return [the saved view, the queries it ran]. */
function storeSave(string $scope, string $name, array $state): array
{
    DB::flushQueryLog();
    DB::enableQueryLog();
    $view = (new DatabaseViewStore)->save($scope, 'items', $name, $state);
    $queries = DB::getQueryLog();
    DB::disableQueryLog();

    return [$view, $queries];
}

it('saves a new view in two queries and returns its id', function () {
    [$view, $queries] = storeSave('u:7', 'Goods', ['search' => 'bol']);

    expect($queries)->toHaveCount(2);
    expect(strtolower($queries[0]['query']))->toContain('insert into')->toContain('on conflict');

    $row = DB::table('laragrid_views')->first();
    expect($view)->toBe(['id' => (string) $row->id, 'name' => 'Goods', 'state' => ['search' => 'bol']]);
    expect(json_decode($row->state, true))->toBe(['search' => 'bol']);
});

it('overwrites by (scope, grid, name) in two queries, keeping the id and created_at', function () {
    Carbon::setTestNow('2026-10-01 09:00:00');
    [$first] = storeSave('u:7', 'Goods', ['search' => 'bol']);
    storeSave('u:7', 'Other', ['search' => 'x']);
    storeSave('u:8', 'Goods', ['search' => 'someone else']);

    Carbon::setTestNow('2026-10-02 10:30:00');
    [$second, $queries] = storeSave('u:7', 'Goods', ['search' => 'anv']);
    Carbon::setTestNow();

    expect($queries)->toHaveCount(2);
    expect($second['id'])->toBe($first['id']);
    expect($second['state'])->toBe(['search' => 'anv']);

    $row = DB::table('laragrid_views')->where('id', $first['id'])->first();
    expect(json_decode($row->state, true))->toBe(['search' => 'anv']);
    expect((string) $row->created_at)->toStartWith('2026-10-01 09:00:00');
    expect((string) $row->updated_at)->toStartWith('2026-10-02 10:30:00');

    expect(DB::table('laragrid_views')->count())->toBe(3);
    expect((new DatabaseViewStore)->list('u:8', 'items')[0]['state'])->toBe(['search' => 'someone else']);
});
