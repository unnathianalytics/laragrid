<?php

declare(strict_types=1);

namespace LaraGrid\Casting\Casts;

use LaraGrid\Casting\Cast;
use LaraGrid\Columns\Column;

/**
 * What: The 'int' kind: strips grouping (commas/spaces), rounds to the nearest integer;
 *       non-numeric input casts to 0.
 *
 * Why:  Mirrors the JS int parse (IntegerColumn) so both runtimes store the same value.
 *
 * When: Resolved by CastRegistry for IntegerColumn commits.
 */
class IntCast implements Cast
{
    public function cast(mixed $value, array $spec, Column $column): int
    {
        $normalised = str_replace([',', ' '], '', (string) ($value ?? ''));

        return is_numeric($normalised) ? (int) round((float) $normalised) : 0;
    }
}
