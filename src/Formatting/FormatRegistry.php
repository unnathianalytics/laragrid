<?php

declare(strict_types=1);

namespace LaraGrid\Formatting;

use InvalidArgumentException;
use LaraGrid\Formatting\Formatters\DateFormatter;
use LaraGrid\Formatting\Formatters\NumberFormatter;
use LaraGrid\Formatting\Formatters\TextFormatter;

/**
 * What: The name → Formatter resolver. Ships the generic core formatters (text/number/date)
 *       and lets the host app register additional ones (this app adds inr/qty via
 *       GridServiceProvider).
 *
 * Why:  The core stays app-agnostic and package-ready by keeping formatters a registry
 *       rather than a hardcoded switch (plan §3.11 / decision record): the accounting-
 *       specific inr/qty formatters are injected from app code, never baked into core.
 *       A single resolver used by both PHP-side rendering (tests, footer totals) and the
 *       serializer's validation of format names keeps the two runtimes honest.
 *
 * When: Resolved from the container as a singleton; core formatters register in the
 *       constructor, app formatters in GridServiceProvider::register().
 */
class FormatRegistry
{
    /**
     * @var array<string, Formatter>
     */
    protected array $formatters = [];

    /**
     * Boot with the app-agnostic core formatters. App-specific ones are added via register().
     */
    public function __construct()
    {
        $this->register('text', new TextFormatter);
        $this->register('number', new NumberFormatter);
        $this->register('date', new DateFormatter);
    }

    /**
     * Register (or override) a named formatter.
     *
     * Why: The extension seam — a consuming app registers its own names here (e.g. 'inr'); another
     *      consumer of an extracted core would register its own without touching core.
     */
    public function register(string $name, Formatter $formatter): void
    {
        $this->formatters[$name] = $formatter;
    }

    /**
     * Whether a formatter is registered under $name.
     */
    public function has(string $name): bool
    {
        return isset($this->formatters[$name]);
    }

    /**
     * Resolve a named formatter, throwing if unknown.
     *
     * @throws InvalidArgumentException When no formatter is registered under $name.
     */
    public function resolve(string $name): Formatter
    {
        return $this->formatters[$name]
            ?? throw new InvalidArgumentException("No grid formatter registered for [{$name}].");
    }

    /**
     * Render a raw value through the named formatter.
     *
     * Why: The convenience the server side uses to pre-compute footer totals and the
     *      FormatVectorsTest uses to assert PHP == expected.
     *
     * @param  array<string, scalar>  $args
     */
    public function format(string $name, mixed $value, array $args = []): string
    {
        return $this->resolve($name)->format($value, $args);
    }
}
