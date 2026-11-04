<?php

declare(strict_types=1);

namespace LaraGrid\Casting\Casts;

use InvalidArgumentException;
use LaraGrid\Casting\Arithmetic;
use LaraGrid\Casting\Cast;
use LaraGrid\Columns\Column;

/**
 * What: The 'decimal' kind: strips grouping, rounds HALF-UP at the column's declared scale,
 *       and returns a fixed-scale decimal STRING. Calculator entry (`100*1.18`) evaluates
 *       first through Arithmetic; a malformed expression casts to 0.
 *
 * Why:  Precision never rides a float (source guardrail G2) — the string survives JSON,
 *       Livewire hydration and DB round-trips exactly. Mirrors the JS decimal parse.
 *
 * When: Resolved by CastRegistry for DecimalColumn (and scale-carrying subclasses).
 */
class DecimalCast implements Cast
{
    public function cast(mixed $value, array $spec, Column $column): string
    {
        $scale = (int) ($spec['scale'] ?? 0);

        try {
            $number = Arithmetic::evaluate($value);
        } catch (InvalidArgumentException) {
            $number = 0.0;
        }
        if ($number === null) {
            $normalised = str_replace([',', ' '], '', (string) ($value ?? ''));
            $number = is_numeric($normalised) ? (float) $normalised : 0.0;
        }

        return number_format(round($number, $scale, PHP_ROUND_HALF_UP), $scale, '.', '');
    }
}
