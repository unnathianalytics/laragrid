<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: A right-aligned fixed-scale decimal column (default scale 2) formatted with the
 *       generic 'number' formatter; the configurable base beneath QtyColumn.
 *
 * Why:  Rates, percentages and generic decimals need a caller-chosen precision without the
 *       Indian grouping money/qty carry. Keeping scale a fluent property that feeds the
 *       format args means the same PHP scale drives the JS formatter over the shared vectors.
 *
 * When: Decimal display columns that aren't quantities or money.
 */
final class DecimalColumn extends Column
{
    protected int $scale = 2;

    /**
     * Set the number of decimal places (also updates the format args).
     */
    public function scale(int $scale): static
    {
        $this->scale = max(0, $scale);
        $this->format('number', ['scale' => $this->scale]);

        return $this;
    }

    protected function configureDefaults(): void
    {
        $this->defaultAlign('right');
        $this->defaultFormat('number', ['scale' => $this->scale]);
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
     * Parsed to a fixed-scale decimal STRING (grouping stripped, rounded half-up at the scale) —
     * kept a string so precision never rides a float (plan G2). Scale threads to the parser.
     *
     * @return array{kind: string, scale: int}
     */
    public function parseSpec(): array
    {
        return ['kind' => 'decimal', 'scale' => $this->scale];
    }

    /** Decimals are summable — the status bar aggregates a selection of decimal cells. */
    public function isSelectableNumeric(): bool
    {
        return true;
    }
}
