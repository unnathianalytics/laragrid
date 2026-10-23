<?php

declare(strict_types=1);

use LaraGrid\Columns\TextColumn;
use LaraGrid\Filters\SelectFilter;
use LaraGrid\Filters\TernaryFilter;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;

/**
 * What: The per-instance lookup memos on Grid (performance plan P3/P4) — column(), getFilters()
 *       and newRowTemplate() compute once and are dropped by the mutators that could change
 *       them — plus the environment gate on the serializer's assertValid() call.
 */
function duplicateKeyGrid(): Grid
{
    return Grid::make('dup')->columns([TextColumn::make('a'), TextColumn::make('a')]);
}

it('enforces assertValid() in testing and skips it in production unless forced', function () {
    expect(fn () => app(ConfigSerializer::class)->serialize(duplicateKeyGrid()))
        ->toThrow(InvalidArgumentException::class, 'duplicate column keys');

    config()->set('laragrid.assert_definitions', false);
    expect(app(ConfigSerializer::class)->serialize(duplicateKeyGrid())['columns'])->toHaveCount(2);

    config()->set('laragrid.assert_definitions', null);
    app()->detectEnvironment(fn (): string => 'production');
    expect(app()->environment())->toBe('production');
    expect(app(ConfigSerializer::class)->serialize(duplicateKeyGrid())['columns'])->toHaveCount(2);

    config()->set('laragrid.assert_definitions', true);
    expect(fn () => app(ConfigSerializer::class)->serialize(duplicateKeyGrid()))
        ->toThrow(InvalidArgumentException::class, 'duplicate column keys');
});

it('resolves column() through an index that follows columns()', function () {
    $a = TextColumn::make('a');
    $b = TextColumn::make('b');
    $grid = Grid::make('g')->columns([$a, $b]);

    expect($grid->column('b'))->toBe($b)
        ->and($grid->column('a'))->toBe($a)
        ->and($grid->column('zz'))->toBeNull();

    $c = TextColumn::make('c');
    $grid->columns([$c]);

    expect($grid->column('a'))->toBeNull()
        ->and($grid->column('c'))->toBe($c);
});

it('memoises getFilters() and refreshes it on filters() and columns()', function () {
    $type = SelectFilter::make('type');
    $grid = Grid::make('g')
        ->columns([TextColumn::make('name')])
        ->filters([$type]);

    expect($grid->getFilters())->toBe([$type])
        ->and($grid->getFilters())->toBe($grid->getFilters());

    $active = TernaryFilter::make('active');
    $grid->filters([$type, $active]);
    expect($grid->getFilters())->toBe([$type, $active]);

    $header = SelectFilter::make('group');
    $grid->columns([TextColumn::make('name')->filterable($header)]);
    expect($grid->getFilters())->toBe([$type, $active, $header]);
});

it('builds newRowTemplate() once and rebuilds it after newRowUsing() or columns()', function () {
    $calls = 0;
    $column = TextColumn::make('a')->default(function () use (&$calls): string {
        $calls++;

        return 'x';
    });
    $grid = Grid::make('g')->editable()->rowsFrom('rows')->authorize(fn (): bool => true)->columns([$column]);

    $grid->newRowTemplate();
    $grid->newRowTemplate();
    expect($grid->newRowTemplate())->toBe(['a' => 'x'])->and($calls)->toBe(1);

    $grid->newRowUsing(fn (): array => ['a' => 'y']);
    expect($grid->newRowTemplate())->toBe(['a' => 'y'])->and($calls)->toBe(2);

    $grid->columns([$column, TextColumn::make('b')]);
    expect($grid->newRowTemplate())->toBe(['a' => 'y', 'b' => null])->and($calls)->toBe(3);

    // makeNewRow() itself is never memoised: every fresh row re-runs the factory closures.
    $grid->makeNewRow('k1');
    expect($calls)->toBe(4);
});
