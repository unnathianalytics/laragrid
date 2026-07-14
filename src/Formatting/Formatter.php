<?php

declare(strict_types=1);

namespace LaraGrid\Formatting;

/**
 * What: The contract every named formatter satisfies — turn a raw cell value plus the
 *       Format's args into a display string.
 *
 * Why:  The FormatRegistry resolves a Format name to one of these; the server uses it to
 *       render values for tests and pre-computed footer totals, exactly mirroring what the
 *       JS port does in the browser. Keeping the surface this small (one method) is what
 *       lets the shared-vector tests assert PHP == expected == JS by construction.
 *
 * When: Implemented by the core (Text/Number/Date) and app (Inr/Qty) formatters; invoked
 *       by FormatRegistry::format().
 */
interface Formatter
{
    /**
     * Render a raw value for display.
     *
     * @param  array<string, scalar>  $args  The owning Format's parameters.
     */
    public function format(mixed $value, array $args = []): string;
}
