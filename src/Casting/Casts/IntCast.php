<?php

declare(strict_types=1);

namespace LaraGrid\Casting\Casts;

use InvalidArgumentException;
use LaraGrid\Casting\Arithmetic;
use LaraGrid\Casting\Cast;
use LaraGrid\Columns\Column;

/**
 * What: The 'int' kind: strips grouping (commas/spaces), rounds to the nearest integer;
 *       non-numeric input casts to 0. Calculator entry (`1250*12`) evaluates first through
 *       Arithmetic; a malformed expression casts to 0 (the client refuses it before the wire).
 *
 * Why:  Mirrors the JS int parse (IntegerColumn) so both runtimes store the same value.
 *
 * When: Resolved by CastRegistry for IntegerColumn commits.
 */
class IntCast implements Cast
{
    public function cast(mixed $value, array $spec, Column $column): int
    {
        try {
            $result = Arithmetic::evaluate($value);
        } catch (InvalidArgumentException) {
            return 0;
        }
        if ($result !== null) {
            return (int) round($result, 0, PHP_ROUND_HALF_UP);
        }

        $normalised = str_replace([',', ' '], '', (string) ($value ?? ''));

        return is_numeric($normalised) ? (int) round((float) $normalised) : 0;
    }
}
