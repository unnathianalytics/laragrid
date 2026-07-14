<?php

declare(strict_types=1);

namespace LaraGrid\Casting\Casts;

use Illuminate\Support\Str;
use LaraGrid\Casting\Cast;
use LaraGrid\Columns\Column;

/**
 * What: The 'text' kind (and the unknown-kind fallback): trimmed string with the column's
 *       declared case transform (->upper()/->lower()) applied.
 *
 * Why:  Mirrors the JS text parse so the optimistic client value and the stored value agree;
 *       the case transform lives here (not in the editor) so paste/fill paths transform too.
 *
 * When: Resolved by CastRegistry for 'text' columns and any unregistered kind.
 */
class TextCast implements Cast
{
    public function cast(mixed $value, array $spec, Column $column): string
    {
        $text = $value === null ? '' : trim((string) $value);

        return match ($column->getCaseTransform()) {
            'upper' => Str::upper($text),
            'lower' => Str::lower($text),
            default => $text,
        };
    }
}
