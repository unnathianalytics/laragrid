<?php

declare(strict_types=1);

namespace LaraGrid;

use LaraGrid\Formatting\Format;

/**
 * What: A footer aggregate over one column — v1 supports sum — carrying an optional display
 *       format tag (->format('number', ['scale' => 2]) or any app-registered format).
 *
 * Why:  Footers are how accountants sanity-check a register, so totals must be authoritative.
 *       In M1 the server pre-computes the sum from the supplied rows during serialization and
 *       ships both the raw total and its format tag; the client paints it and (from M4) will
 *       reconcile live totals against op responses. Modelling the format as a Format tag keeps
 *       the footer using the same formatter table as the columns.
 *
 * When: Passed to Grid->footer([...]); the serializer computes each aggregate's value and the
 *       client FooterRenderer paints the footer row.
 */
final class Aggregate
{
    protected ?Format $format = null;

    private function __construct(
        public readonly string $column,
        public readonly string $type,
    ) {}

    /**
     * A sum aggregate over $column.
     */
    public static function sum(string $column): self
    {
        return new self($column, 'sum');
    }

    /**
     * Apply a display format — a Format instance, or a registered format name + args
     * (core: 'text'/'number'/'date'; plus any formats the app registered, so an accounting
     * app writes ->format('inr') exactly as it would a core name).
     *
     * @param  array<string, scalar>  $args
     */
    public function format(Format|string $format, array $args = []): self
    {
        $this->format = $format instanceof Format ? $format : Format::make($format, $args);

        return $this;
    }

    public function resolvedFormat(): ?Format
    {
        return $this->format;
    }

    /**
     * Compute this aggregate's raw value over the supplied rows.
     *
     * Why: Server-authoritative footer totals for M1's readonly display; summing the numeric
     *      cast of each row's cell keeps paise integers exact and treats blanks as zero.
     *
     * @param  iterable<array<string, mixed>>  $rows
     */
    public function compute(iterable $rows): int|float
    {
        $total = 0;
        $isFloat = false;

        foreach ($rows as $row) {
            // A missing/null cell coalesces to 0; a present empty string is skipped too.
            $value = $row[$this->column] ?? 0;

            if ($value === '') {
                continue;
            }

            if (is_float($value) || (is_string($value) && str_contains($value, '.'))) {
                $isFloat = true;
            }

            $total += $value + 0;
        }

        return $isFloat ? (float) $total : (int) $total;
    }

    /**
     * The declarative fragment: {column, type, format, value} with the pre-computed total.
     *
     * @param  iterable<array<string, mixed>>  $rows
     * @return array{column: string, type: string, format: array{name: string, args: array<string, scalar>}|null, value: int|float}
     */
    public function toArray(iterable $rows): array
    {
        return [
            'column' => $this->column,
            'type' => $this->type,
            'format' => $this->format?->toArray(),
            'value' => $this->compute($rows),
        ];
    }
}
