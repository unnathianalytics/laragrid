<?php

declare(strict_types=1);

namespace LaraGrid\Formatting\Formatters;

use LaraGrid\Formatting\Formatter;

/**
 * What: The default, generic text formatter — coerces any value to a string, with an
 *       optional case transform ('upper' | 'lower') via args.
 *
 * Why:  This is the app-agnostic core fallback for columns that carry no richer format;
 *       it must never assume accounting or locale semantics (those live in the app Inr/Qty
 *       formatters), so it does nothing but null-safe stringification and case folding.
 *
 * When: Registered as 'text' in the core FormatRegistry boot; used by Text/Serial columns
 *       and as the safety-net default when a column declares no format.
 */
final class TextFormatter implements Formatter
{
    /**
     * @param  array<string, scalar>  $args  Supports {transform: 'upper'|'lower'}.
     */
    public function format(mixed $value, array $args = []): string
    {
        if ($value === null) {
            return '';
        }

        $text = is_bool($value) ? ($value ? 'true' : 'false') : (string) $value;

        return match ($args['transform'] ?? null) {
            'upper' => mb_strtoupper($text),
            'lower' => mb_strtolower($text),
            default => $text,
        };
    }
}
