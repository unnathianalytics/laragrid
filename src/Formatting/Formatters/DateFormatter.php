<?php

declare(strict_types=1);

namespace LaraGrid\Formatting\Formatters;

use DateTimeInterface;
use Illuminate\Support\Carbon;
use LaraGrid\Formatting\Formatter;
use Throwable;

/**
 * What: A generic date formatter — parses an ISO/Y-m-d style value (or a DateTime) and
 *       re-renders it in a display pattern (default d-m-Y, the Indian convention used
 *       across this app's registers).
 *
 * Why:  Dates ride the row model as ISO strings (stable, sortable, JSON-clean); the human
 *       display pattern is a cosmetic concern this formatter owns so the PHP and JS ports
 *       agree over the shared vectors. The default 'd-m-Y' matches the report screens; the
 *       pattern is overridable per column via args so the core itself stays locale-neutral.
 *
 * When: Registered as 'date' in the core FormatRegistry; used by DateColumn.
 */
final class DateFormatter implements Formatter
{
    /**
     * @param  array<string, scalar>  $args  Supports {display: string PHP date() pattern (default 'd-m-Y')}.
     */
    public function format(mixed $value, array $args = []): string
    {
        if ($value === null || $value === '') {
            return '';
        }

        $display = (string) ($args['display'] ?? 'd-m-Y');

        if ($value instanceof DateTimeInterface) {
            return $value->format($display);
        }

        try {
            return Carbon::parse((string) $value)->format($display);
        } catch (Throwable) {
            // A value that isn't a recognisable date is shown verbatim rather than throwing:
            // display formatting must never break a readonly render over host-supplied rows.
            return (string) $value;
        }
    }
}
