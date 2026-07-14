<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: An explicitly display-only text column — identical to TextColumn in M1, but named
 *       to signal "never editable" and to be skipped by navigation/editing later.
 *
 * Why:  The plan's column set distinguishes Readonly from Text so that when editing lands
 *       (M2+), the keyboard/skip logic and the op applier can reject writes to this column
 *       by type rather than by a boolean. Reserving the type now keeps M1 config forward-
 *       compatible without an editor.
 *
 * When: Columns that must remain read-only even in an otherwise editable grid.
 */
final class ReadonlyColumn extends Column
{
    protected function configureDefaults(): void
    {
        $this->defaultAlign('left');
    }

    public function painterId(): string
    {
        return 'text';
    }

    /**
     * Emit the readonly marker so the client (and later the op applier) knows this column
     * is non-editable by type, not just by a per-cell flag.
     *
     * @return array{readonly: true}
     */
    protected function serializeType(): array
    {
        return ['readonly' => true];
    }
}
