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
    | Color scheme
    |--------------------------------------------------------------------------
    | One of the shipped presets ('zinc', 'blue', 'emerald', 'amber', 'rose',
    | 'violet' — each with light + dark variants), or null for the neutral
    | default. Per grid: ->theme('blue'), or ->themeClass() for custom tokens.
    */
    'theme' => null,

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
    | Mount payload ceiling
    |--------------------------------------------------------------------------
    | The most rows a server-side grid may INLINE into its mount HTML (page 1).
    | Above it the initial payload is DEFERRED to a post-boot gridFetch — rows
    | travel as JSON, which Livewire never regex-processes as HTML. paginate()
    | sizes above this without ->singlePageUpTo() fail at build time.
    */
    'max_per_page' => 1000,

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
    | Exports
    |--------------------------------------------------------------------------
    | Defaults for readonly grids that chain ->exportable(). `formats` is the
    | set offered when ->exportable() is called with no arguments — any subset
    | (or app-registered format) can be chosen per grid: ->exportable(['csv']).
    | `max_rows` caps how many rows a single download may carry (a per-grid
    | ->exportable(limit:) overrides it); `chunk` is the streaming page size
    | used while building the file.
    */
    'export' => [
        'formats' => ['csv', 'xlsx', 'pdf'],
        'max_rows' => 50000,
        'chunk' => 500,
    ],

    /*
    |--------------------------------------------------------------------------
    | Saved views
    |--------------------------------------------------------------------------
    | Defaults for grids that chain ->savedViews() (named, per-user snapshots
    | of a readonly grid's search/filters/sort/per-page/column layout).
    | `table` is where the shipped DatabaseViewStore keeps them (the packaged
    | migration creates it on `artisan migrate`); rebind the
    | LaraGrid\Views\ViewStore interface for custom storage. `max_per_grid`
    | caps how many views one operator may save on one grid.
    */
    'views' => [
        'table' => 'laragrid_views',
        'max_per_grid' => 50,
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
