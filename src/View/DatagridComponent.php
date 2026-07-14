<?php

declare(strict_types=1);

namespace LaraGrid\View;

use Illuminate\Contracts\View\View;
use Illuminate\View\Component;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;

/**
 * What: The <x-laragrid :grid :rows> Blade component — the bridge between a PHP Grid
 *       definition + host rows and the client renderer. It serializes the grid to the
 *       declarative config and embeds it in the mount as a JSON block the vanilla boot
 *       module reads.
 *
 * Why:  Doing the serialization here keeps the view dumb and the payload a single testable
 *       array. The grid body renders entirely client-side inside a `wire:ignore` region, so
 *       Livewire never morphs a cell; the mount carries only `data-lgrid` markers — no
 *       Alpine, no directives, nothing for the host page to configure (the zero-blade-config
 *       rule: every behavior lives on the Grid definition).
 *
 * When: Rendered wherever a host places <x-laragrid :grid="$this->gridDefinition('name')">;
 *       registered as `laragrid` by the service provider.
 */
class DatagridComponent extends Component
{
    /**
     * The serialized declarative config embedded into the mount's JSON block.
     *
     * @var array<string, mixed>
     */
    public array $config;

    /**
     * @param  Grid  $grid  The grid definition.
     * @param  iterable<int, array<string, mixed>>  $rows  Host rows for in-memory grids; ignored by ->query() grids.
     */
    public function __construct(
        public Grid $grid,
        iterable $rows = [],
    ) {
        $this->config = app(ConfigSerializer::class)->serialize($grid, $rows);
    }

    public function render(): View
    {
        return view('laragrid::datagrid');
    }
}
