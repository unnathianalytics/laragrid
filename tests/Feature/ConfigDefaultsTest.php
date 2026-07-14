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
