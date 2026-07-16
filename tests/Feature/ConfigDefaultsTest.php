<?php

declare(strict_types=1);

use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\GridDensity;
use LaraGrid\Support\ConfigSerializer;

it('seeds density and keymap from config/laragrid.php, with chains overriding', function () {
    config()->set('laragrid.density', 'comfortable');
    config()->set('laragrid.keymap', 'excel');

    $grid = Grid::make('g')->columns([TextColumn::make('name')]);
    $layout = (new ConfigSerializer)->serialize($grid)['layout'];

    expect($layout['density'])->toBe('comfortable');
    expect($layout['keymap'])->toBe('excel');

    // A chained call still wins over the config default.
    $overridden = Grid::make('g2')->columns([TextColumn::make('name')])
        ->density(GridDensity::Compact)
        ->keymap('entry');
    $layout = (new ConfigSerializer)->serialize($overridden)['layout'];

    expect($layout['density'])->toBe('compact');
    expect($layout['keymap'])->toBe('entry');
});

it('falls back to shipped defaults on invalid config values', function () {
    config()->set('laragrid.density', 'gigantic');
    config()->set('laragrid.keymap', 'vim');

    $layout = (new ConfigSerializer)->serialize(
        Grid::make('g')->columns([TextColumn::make('name')])
    )['layout'];

    expect($layout['density'])->toBe('compact');
    expect($layout['keymap'])->toBe('entry');
});

it('applies shipped themes via ->theme(), config default, and rejects unknown names', function () {
    $grid = Grid::make('t')->columns([TextColumn::make('name')])->theme('blue');
    expect((new ConfigSerializer)->serialize($grid)['layout']['themeClass'])
        ->toBe('lgrid--theme-blue');

    config()->set('laragrid.theme', 'emerald');
    $seeded = Grid::make('t2')->columns([TextColumn::make('name')]);
    expect((new ConfigSerializer)->serialize($seeded)['layout']['themeClass'])
        ->toBe('lgrid--theme-emerald');

    expect(fn () => Grid::make('t3')->theme('neon'))
        ->toThrow(InvalidArgumentException::class, 'unknown theme [neon]');
});
