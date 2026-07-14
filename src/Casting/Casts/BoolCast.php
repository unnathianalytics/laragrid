<?php

declare(strict_types=1);

namespace LaraGrid\Casting\Casts;

use LaraGrid\Casting\Cast;
use LaraGrid\Columns\Column;

/**
 * What: The 'bool' kind: real booleans pass; '1'/'0'/'true'/'false'/1/0 map; anything
 *       unrecognised → false.
 *
 * Why:  Mirrors the JS bool parse so the optimistic checkbox toggle and the stored value agree.
 *
 * When: Resolved by CastRegistry for CheckboxColumn commits.
 */
class BoolCast implements Cast
{
    public function cast(mixed $value, array $spec, Column $column): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        return filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? false;
    }
}
