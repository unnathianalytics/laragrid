<?php

declare(strict_types=1);

namespace LaraGrid\Casting\Casts;

use LaraGrid\Casting\Cast;
use LaraGrid\Columns\Column;

/**
 * What: The 'yn' kind: real booleans pass; 'y'/'yes'/'1'/'true'/'on' (case-insensitive) map to
 *       true; anything unrecognised → false.
 *
 * Why:  Mirrors the JS parseYn so the optimistic typed Y/N commit and the stored value agree. A
 *       distinct kind rather than a widened 'bool': the checkbox's BoolCast is pinned to PHP's
 *       FILTER_VALIDATE_BOOLEAN (which rejects 'y'), and that contract stays untouched.
 *
 * When: Resolved by CastRegistry for YesNoColumn commits.
 */
class YnCast implements Cast
{
    public function cast(mixed $value, array $spec, Column $column): bool
    {
        if (is_bool($value)) {
            return $value;
        }

        if (! is_scalar($value)) {
            return false;
        }

        return in_array(strtolower(trim((string) $value)), ['y', 'yes', '1', 'true', 'on'], true);
    }
}
