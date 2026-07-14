<?php

declare(strict_types=1);

/**
 * LaraGrid — application-wide defaults.
 *
 * Every value here is a DEFAULT only: any grid overrides any of them through its
 * chained definition (->density(), ->keymap(), ->toolbar(), DateColumn::displayFormat(),
 * ->financialYear(), ...). Per the package's design rule, behavior is controlled in the
 * component class — this file exists solely so an app can shift the baseline once
 * instead of chaining the same override onto every grid.
 */
return [

    /*
    |--------------------------------------------------------------------------
    | Row density
    |--------------------------------------------------------------------------
    | 'compact' | 'normal' | 'comfortable' — the default GridDensity applied
    | when a definition does not chain ->density().
    */
    'density' => 'compact',

    /*
    |--------------------------------------------------------------------------
    | Keyboard preset
    |--------------------------------------------------------------------------
    | 'entry' (serpentine Enter flow, data-entry style) or 'excel'
    | (Enter moves down, Tab moves right).
    */
    'keymap' => 'entry',

    /*
    |--------------------------------------------------------------------------
    | Dates
    |--------------------------------------------------------------------------
    | display        — default DateColumn/date-formatter display pattern.
    | fy_start_month — financial-year start month (1-12) used by fuzzy date
    |                  entry to infer years, or null to disable FY inference
    |                  entirely (plain calendar parsing). Opt back in per
    |                  column via ->financialYear().
    */
    'date' => [
        'display' => 'd-m-Y',
        'fy_start_month' => null,
    ],

    /*
    |--------------------------------------------------------------------------
    | Toolbar defaults
    |--------------------------------------------------------------------------
    | Which package-rendered toolbar controls appear when a grid declares the
    | matching capability (searchable/filters/pagination). ->toolbar(false)
    | or ->toolbar(search: false, ...) overrides per grid.
    */
    'toolbar' => [
        'search' => true,
        'filters' => true,
        'per_page' => true,
        'chooser' => true,
    ],

    /*
    |--------------------------------------------------------------------------
    | Asset injection
    |--------------------------------------------------------------------------
    | When true the service provider auto-injects the prebuilt dist/ script and
    | stylesheet into responses that rendered a grid (the Livewire model). Set
    | false to take manual control via @laragridScripts / @laragridStyles.
    */
    'inject_assets' => true,

    /*
    |--------------------------------------------------------------------------
    | Asset URL
    |--------------------------------------------------------------------------
    | null serves the bundled dist/ files over the internal /laragrid/{file}
    | route. Set a base URL to serve them from a CDN or a published copy
    | (e.g. '/vendor/laragrid' after `artisan vendor:publish --tag=laragrid-assets`).
    */
    'asset_url' => null,

];
