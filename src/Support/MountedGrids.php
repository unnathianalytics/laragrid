<?php

declare(strict_types=1);

namespace LaraGrid\Support;

/**
 * What: The request-scoped bridge between a WithLaraGrid host and the <x-laragrid> Blade
 *       component: which grids the host's PREVIOUS render already mounted in the browser, and
 *       which grids the CURRENT render pass is mounting.
 *
 * Why:  The grid body lives inside `wire:ignore`, so on a Livewire update the mount — and its
 *       inline JSON config — is never morphed; the browser reads the config block once, at
 *       first paint. Re-serializing every row (and, for a ->query() grid, re-running COUNT +
 *       SUMs + the page SELECT) on every non-renderless host update is work nobody reads. The
 *       Blade component cannot see the host, so the trait's rendering/rendered hooks open a
 *       frame here with the host's hydrated "mounted" set and collect what this pass renders;
 *       the component asks isMounted() and marks itself. Frames stack so a nested host
 *       (a child Livewire component with its own grids) never clobbers its parent's frame.
 *
 * When: Bound `scoped` by the service provider (flushed per request under Octane, so a
 *       render that throws between the two hooks can never leak a frame into the next
 *       request). Entered/left by WithLaraGrid; read by DatagridComponent.
 */
final class MountedGrids
{
    /**
     * @var list<array{mounted: array<string, true>, rendered: array<string, true>}>
     */
    private array $frames = [];

    /**
     * Open a render pass for a host whose browser already mounted `$mounted` (grid name => true).
     *
     * @param  array<string, true>  $mounted
     */
    public function enter(array $mounted): void
    {
        $this->frames[] = ['mounted' => $mounted, 'rendered' => []];
    }

    /**
     * Close the current render pass and return the grids it rendered (grid name => true).
     *
     * @return array<string, true>
     */
    public function leave(): array
    {
        $frame = array_pop($this->frames);

        return $frame === null ? [] : $frame['rendered'];
    }

    /** Whether a host render pass is open (false on a plain Blade page or outside a host). */
    public function active(): bool
    {
        return $this->frames !== [];
    }

    /** Whether the browser already holds a live mount of this grid from the host's last render. */
    public function isMounted(string $grid): bool
    {
        $frame = end($this->frames);

        return $frame !== false && isset($frame['mounted'][$grid]);
    }

    /** Record that the current render pass mounted this grid. No-op outside a pass. */
    public function mark(string $grid): void
    {
        $index = array_key_last($this->frames);
        if ($index !== null) {
            $this->frames[$index]['rendered'][$grid] = true;
        }
    }
}
