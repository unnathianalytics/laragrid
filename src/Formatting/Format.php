<?php

declare(strict_types=1);

namespace LaraGrid\Formatting;

/**
 * What: An immutable {name, args} value object naming a formatter and its parameters
 *       (e.g. Format::make('number', ['scale' => 2])).
 *
 * Why:  Formatting is the one layer intentionally implemented in both PHP and JS (plan
 *       R2). Rather than smuggle formatting *logic* across the wire, a column serializes
 *       only this declarative tag; the client looks the name up in its own formatter
 *       table and applies it with the same args. The PHP FormatRegistry resolves the same
 *       name for server-side rendering and the shared-vector tests — one contract, two
 *       cosmetic evaluators, pinned by fixtures.
 *
 * When: Held by a column (via HasFormat) and emitted into a column's serialized fragment;
 *       resolved by FormatRegistry when PHP needs to render a value (tests, footer values).
 */
final class Format
{
    /**
     * @param  array<string, scalar>  $args  Formatter parameters serialized verbatim into config.
     */
    public function __construct(
        public readonly string $name,
        public readonly array $args = [],
    ) {}

    /**
     * @param  array<string, scalar>  $args
     */
    public static function make(string $name, array $args = []): self
    {
        return new self($name, $args);
    }

    /**
     * The declarative config fragment the client interprets: {name, args}.
     *
     * @return array{name: string, args: array<string, scalar>}
     */
    public function toArray(): array
    {
        return ['name' => $this->name, 'args' => $this->args];
    }
}
