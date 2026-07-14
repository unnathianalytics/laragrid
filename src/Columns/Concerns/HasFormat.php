<?php

declare(strict_types=1);

namespace LaraGrid\Columns\Concerns;

use LaraGrid\Formatting\Format;

/**
 * What: Fluent formatter resolution for a column — accepts either a formatter name string
 *       (with optional args) or a ready Format value object, and exposes the resolved
 *       Format for serialization.
 *
 * Why:  Every column carries a default Format tag appropriate to its type (Amount → inr,
 *       Qty → qty, Date → date, else text); ->format() lets the host override it. The
 *       column serializes only the {name, args} tag — never formatting logic — so the
 *       client can apply the matching formatter from its own table (plan R2, declarative
 *       bridge). Keeping resolution in a concern means all nine column types share it.
 *
 * When: Mixed into the Column base; the default is set by each concrete type's constructor.
 */
trait HasFormat
{
    protected ?Format $format = null;

    /**
     * Override the column's display format.
     *
     * @param  string|Format  $format  A formatter name (resolved with $args) or a Format object.
     * @param  array<string, scalar>  $args  Formatter parameters when $format is a name.
     */
    public function format(string|Format $format, array $args = []): static
    {
        $this->format = $format instanceof Format ? $format : Format::make($format, $args);

        return $this;
    }

    /**
     * Set the type-default format without overriding an explicit ->format() call.
     *
     * @param  array<string, scalar>  $args
     */
    protected function defaultFormat(string $name, array $args = []): void
    {
        $this->format ??= Format::make($name, $args);
    }

    /**
     * The resolved Format, or null when the column has none (client falls back to 'text').
     */
    public function resolvedFormat(): ?Format
    {
        return $this->format;
    }
}
