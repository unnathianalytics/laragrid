<?php

declare(strict_types=1);

namespace LaraGrid\View;

use Illuminate\Contracts\View\View;
use Illuminate\View\Component;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;
use LaraGrid\Support\MountedGrids;

/**
 * What: The <x-laragrid :grid :rows> Blade component — the bridge between a PHP Grid
 *       definition + host rows and the client renderer. It serializes the grid to the
 *       declarative config and embeds it in the mount as a JSON block the vanilla boot
 *       module reads.
 *
 * Why:  Doing the serialization here keeps the view dumb and the payload a single testable
 *       array. The grid body renders entirely client-side inside a `wire:ignore` region, so
 *       Livewire never morphs a cell; the mount carries only `data-lgrid` markers — no
 *       directives, nothing for the host page to configure (the zero-blade-config rule:
 *       every behavior lives on the Grid definition). Because that region is never morphed,
 *       a host RE-render of a grid the browser already holds ships a shell config (no rows, no
 *       queries) — MountedGrids carries "already mounted" over from the host's last render.
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
        $serializer = app(ConfigSerializer::class);
        $mounted = app(MountedGrids::class);

        $this->config = $mounted->isMounted($grid->name) && $serializer->canShell($grid)
            ? $serializer->serializeShell($grid)
            : $serializer->serialize($grid, $rows);

        $mounted->mark($grid->name);
    }

    public function render(): View
    {
        /** @var view-string $view */
        $view = 'laragrid::datagrid';

        return view($view);
    }
}
