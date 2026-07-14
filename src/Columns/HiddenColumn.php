<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: A column that lives in the row model but is never rendered — a carried value (a foreign
 *       key, a cached label, a server-only flag) the grid tracks per row without a visible cell.
 *
 * Why:  Editable rows often carry data the operator never edits directly but which travels with
 *       the row (e.g. a picked item's uom_id set by an onSelect hook, or an id needed at save).
 *       Modelling it as a column keeps it inside the one row model + the op protocol rather than
 *       a side channel. By default the OpApplier REJECTS a direct client write to a hidden column
 *       (plan G12 — the client can't smuggle a value into a field it never shows); ->writable()
 *       opts in when a client-set hidden value is legitimate.
 *
 * When: Any per-row value that must be tracked but not displayed.
 */
final class HiddenColumn extends Column
{
    /** Whether the OpApplier accepts a direct client write to this hidden column (default: no). */
    protected bool $writable = false;

    protected function configureDefaults(): void
    {
        $this->visible = false;
    }

    public function painterId(): string
    {
        // Never painted (visible=false), but the base requires a painter id.
        return 'text';
    }

    /**
     * Allow the client to set this hidden column's value directly (opt-in, plan G12).
     */
    public function writable(bool $writable = true): static
    {
        $this->writable = $writable;

        return $this;
    }

    public function isWritable(): bool
    {
        return $this->writable;
    }

    /** Hidden cells are never a navigation/edit target. */
    public function isNavigable(): bool
    {
        return false;
    }

    /**
     * @return array{hidden: true}
     */
    protected function serializeType(): array
    {
        return ['hidden' => true];
    }
}
