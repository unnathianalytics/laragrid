<?php

declare(strict_types=1);

namespace LaraGrid\Casting\Casts;

use LaraGrid\Casting\Cast;
use LaraGrid\Columns\Column;

/**
 * What: The 'select' kind: a picker value is an opaque option id — trimmed string, with
 *       blank normalising to null (a cleared pick).
 *
 * Why:  WHICH ids are acceptable is validation's job (the implicit in:/author exists: rules),
 *       not the cast's; keeping the cast dumb mirrors the JS select parse exactly.
 *
 * When: Resolved by CastRegistry for SelectColumn / SearchSelectColumn commits.
 */
class SelectCast implements Cast
{
    public function cast(mixed $value, array $spec, Column $column): ?string
    {
        $text = trim((string) ($value ?? ''));

        return $text === '' ? null : $text;
    }
}
