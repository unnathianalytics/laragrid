<?php

declare(strict_types=1);

namespace LaraGrid\Columns\Concerns;

use InvalidArgumentException;

/**
 * What: Fluent horizontal alignment for a column ('left' | 'right' | 'center').
 *
 * Why:  Alignment is a stable per-column concern the client renders as a semantic state
 *       class (lgrid-cell--right / --center), never a composed utility (Tailwind purge, R8).
 *       Each concrete column type sets a sensible default (numbers right, text left) in its
 *       constructor; ->align() overrides it. Validating the value here fails fast on a typo
 *       rather than silently emitting an unstyled alignment.
 *
 * When: Mixed into the Column base; read by ConfigSerializer.
 */
trait HasAlignment
{
    protected string $align = 'left';

    /**
     * Set the column alignment. Accepts 'left' | 'right' | 'center'; anything else throws so a
     * typo can't ship an unstyled alignment (the value is widened to string precisely so this
     * runtime guard is meaningful to dynamic callers).
     */
    public function align(string $align): static
    {
        if (! in_array($align, ['left', 'right', 'center'], true)) {
            throw new InvalidArgumentException("Invalid column alignment [{$align}]; expected left, right or center.");
        }

        $this->align = $align;

        return $this;
    }

    /**
     * Set the default alignment without validation (called by concrete column constructors).
     */
    protected function defaultAlign(string $align): void
    {
        $this->align = $align;
    }
}
