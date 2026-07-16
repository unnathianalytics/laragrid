<?php

declare(strict_types=1);

use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Illuminate\Validation\ValidationException;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Tests\Hosts\ExportItem;
use LaraGrid\Tests\Hosts\TestUser;
use LaraGrid\Tests\Hosts\ViewsGridComponent;

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

    // The packaged migration, run directly — proves the shipped file creates the store's table.
    $migration = require dirname(__DIR__, 2).'/database/migrations/2026_07_16_000001_create_laragrid_views_table.php';
    $migration->up();
});

/** A ready host acting as user #$id. */
function viewsHost(int $userId = 7): ViewsGridComponent
{
    test()->actingAs(new TestUser(['id' => $userId]));

    return new ViewsGridComponent;
}

/** A representative full state for the rig's grid. */
function currentState(): array
{
    return [
        'search' => 'bol',
        'sort' => 'qty',
        'dir' => 'desc',
        'filters' => ['type' => 'goods'],
        'perPage' => 5,
        'widths' => ['name' => 240],
        'hidden' => ['type'],
    ];
}

// ---- Build-time + config serialization -------------------------------------------------------

it('rejects savedViews() on a grid without query() at build time', function () {
    $grid = Grid::make('d')->columns([TextColumn::make('n')])->savedViews();

    expect(fn () => $grid->assertValid())
        ->toThrow(InvalidArgumentException::class, 'saved views need a server-side readonly grid');
});

it('serializes layout.views when declared, and omits it when not', function () {
    $on = new ViewsGridComponent;
    $config = app(ConfigSerializer::class)->serialize($on->gridDefinition('items'));
    expect($config['layout']['views'])->toBeTrue();

    $off = new ViewsGridComponent;
    $off->viewsOff = true;
    $config = app(ConfigSerializer::class)->serialize($off->gridDefinition('items'));
    expect($config['layout'])->not->toHaveKey('views');
});

// ---- The RPC surface, fail-closed -------------------------------------------------------------

it('saves, lists, overwrites and deletes views for the acting user', function () {
    $host = viewsHost();

    $saved = $host->gridViewSave('items', '  Pending goods ', currentState());
    expect($saved['view']['name'])->toBe('Pending goods');
    expect($saved['views'])->toHaveCount(1);

    // Same name = overwrite, never a duplicate.
    $again = $host->gridViewSave('items', 'Pending goods', ['search' => 'anv'] + currentState());
    expect($again['views'])->toHaveCount(1);
    expect($again['view']['id'])->toBe($saved['view']['id']);
    expect($host->gridViews('items')['views'][0]['state']['search'])->toBe('anv');

    $rest = $host->gridViewDelete('items', $saved['view']['id']);
    expect($rest['views'])->toBe([]);
});

it('sanitizes the stored state against the grid declaration', function () {
    $host = viewsHost();

    $view = $host->gridViewSave('items', 'Messy', [
        'search' => str_repeat('x', 500),
        'sort' => 'secret_db_column',            // not a declared column
        'dir' => 'sideways',
        'filters' => ['type' => 'goods', 'evil' => '1; DROP TABLE'],
        'perPage' => 9999,                       // not one of the declared options
        'widths' => ['name' => 240.7, 'ghost' => 100, 'qty' => 999999],
        'hidden' => ['type', 'ghost', 'type'],
        'injected' => 'nope',                    // unknown top-level key
    ])['view'];

    expect($view['state'])->toBe([
        'search' => str_repeat('x', 200),
        'sort' => null,
        'dir' => 'asc',
        'filters' => ['type' => 'goods'],
        'perPage' => 2,
        'widths' => ['name' => 240, 'qty' => 2000],
        'hidden' => ['type'],
    ]);
});

it('scopes views per user — one operator never sees another\'s', function () {
    viewsHost(7)->gridViewSave('items', 'Mine', currentState());

    $other = viewsHost(8);
    expect($other->gridViews('items')['views'])->toBe([]);

    // A foreign id is a silent no-op, never a cross-user delete.
    $mineId = viewsHost(7)->gridViews('items')['views'][0]['id'];
    viewsHost(8)->gridViewDelete('items', $mineId);
    expect(viewsHost(7)->gridViews('items')['views'])->toHaveCount(1);
});

it('refuses guests — saved views need an authenticated user', function () {
    $host = new ViewsGridComponent;

    expect(fn () => $host->gridViews('items'))
        ->toThrow(AuthorizationException::class, 'authenticated user');
});

it('refuses a grid that never declared savedViews()', function () {
    $host = viewsHost();
    $host->viewsOff = true;

    expect(fn () => $host->gridViews('items'))
        ->toThrow(InvalidArgumentException::class, 'does not declare savedViews()');
});

it('re-runs the grid authorize gate on every views RPC', function () {
    $host = viewsHost();
    $host->deny = true;

    expect(fn () => $host->gridViewSave('items', 'X', []))
        ->toThrow(AuthorizationException::class, 'Denied.');
});

it('rejects a blank or over-long name', function () {
    $host = viewsHost();

    expect(fn () => $host->gridViewSave('items', '   ', []))
        ->toThrow(ValidationException::class);
    expect(fn () => $host->gridViewSave('items', str_repeat('n', 61), []))
        ->toThrow(ValidationException::class);
});

it('caps views per grid but still allows overwriting at the cap', function () {
    config()->set('laragrid.views.max_per_grid', 2);
    $host = viewsHost();

    $host->gridViewSave('items', 'One', []);
    $host->gridViewSave('items', 'Two', []);

    expect(fn () => $host->gridViewSave('items', 'Three', []))
        ->toThrow(ValidationException::class);

    // Overwriting an existing name is an update, not a new slot.
    expect($host->gridViewSave('items', 'Two', currentState())['views'])->toHaveCount(2);
});
