<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: A right-aligned whole-number column formatted with the generic 'number' formatter
 *       at scale 0.
 *
 * Why:  Counts and HSN-like integers read right-aligned with tabular figures; using the
 *       locale-neutral core number formatter (plain thousands grouping) keeps the type
 *       app-agnostic — Indian grouping is reserved for the app qty/inr types.
 *
 * When: Integer-valued display columns.
 */
final class IntegerColumn extends Column
{
    protected function configureDefaults(): void
    {
        $this->defaultAlign('right');
        $this->defaultFormat('number', ['scale' => 0]);
    }

    public function painterId(): string
    {
        return 'text';
    }

    /** Edited with the numeric editor. */
    public function editorId(): string
    {
        return 'number';
    }

    /**
     * Parsed to a whole number (grouping stripped, rounded to an integer).
     *
     * @return array{kind: string}
     */
    public function parseSpec(): array
    {
        return ['kind' => 'int'];
    }

    /** Whole numbers are summable — the status bar aggregates a selection of integer cells. */
    public function isSelectableNumeric(): bool
    {
        return true;
    }
}
