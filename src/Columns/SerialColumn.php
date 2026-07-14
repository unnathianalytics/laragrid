<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: The row-number gutter column — renders the 1-based ordinal of each row, not a
 *       value from the row model.
 *
 * Why:  A serial gutter is the accountant's anchor for reading a register and, later, the
 *       row-selection handle (M2). It carries no data key of its own, so the client's serial
 *       painter fills it from the row's position rather than from row[key]; marking that with
 *       a distinct painter id keeps the body renderer type-agnostic.
 *
 * When: Placed first in a columns() list; display-only in M1.
 */
final class SerialColumn extends Column
{
    /**
     * SerialColumn is keyless (its value is the row ordinal); ::make() defaults the key so
     * callers can write SerialColumn::make() with no argument, matching the plan's examples.
     */
    public static function make(string $key = '_serial'): static
    {
        return new self($key);
    }

    protected function configureDefaults(): void
    {
        $this->defaultAlign('right');
        $this->label ??= '#';

        if ($this->width === null) {
            $this->width(48);
        }
    }

    public function painterId(): string
    {
        return 'serial';
    }

    /**
     * The gutter is a reading anchor and (M2) the row-selection handle, never a navigation
     * target — arrows/Tab step over it so the active cell only ever sits on a value cell.
     */
    public function isNavigable(): bool
    {
        return false;
    }
}
