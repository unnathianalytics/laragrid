<?php

declare(strict_types=1);

namespace LaraGrid\Casting\Casts;

use LaraGrid\Casting\Cast;
use LaraGrid\Columns\Column;

/**
 * What: The 'date' kind: blank → null; anything else passes through as the text the client
 *       committed.
 *
 * Why:  The CLIENT resolves fuzzy typed dates to canonical ISO (the shared date parser); the
 *       server never guesses — DateColumn's implicit date_format:Y-m-d rule flags anything
 *       non-ISO or impossible. A silent server-side reinterpretation could store a date the
 *       operator never saw.
 *
 * When: Resolved by CastRegistry for DateColumn commits.
 */
class DateCast implements Cast
{
    public function cast(mixed $value, array $spec, Column $column): ?string
    {
        $text = trim((string) ($value ?? ''));

        return $text === '' ? null : $text;
    }
}
