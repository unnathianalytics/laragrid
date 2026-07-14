<?php

declare(strict_types=1);

namespace LaraGrid\Formatting\Formatters;

use LaraGrid\Formatting\Formatter;

/**
 * What: A generic, locale-neutral fixed-scale number formatter — rounds to a given number
 *       of decimals and (optionally) groups the integer part with a plain thousands comma.
 *
 * Why:  The core must offer a number format that carries NO Indian/accounting assumptions
 *       (that is the app QtyFormatter's job); this one groups in thousands the way every
 *       non-Indian locale expects, so an extracted core stays correct elsewhere. Rounding
 *       is half-up at the target scale to match the grid's stated rounding convention (G2).
 *
 * When: Registered as 'number' in the core FormatRegistry; used by Integer/Decimal columns
 *       that don't opt into the app qty/inr formats.
 */
final class NumberFormatter implements Formatter
{
    /**
     * @param  array<string, scalar>  $args  Supports {scale: int (default 0), group: bool (default true)}.
     */
    public function format(mixed $value, array $args = []): string
    {
        if ($value === null || $value === '') {
            return '';
        }

        $scale = max(0, (int) ($args['scale'] ?? 0));
        $group = (bool) ($args['group'] ?? true);

        return number_format((float) $value, $scale, '.', $group ? ',' : '');
    }
}
