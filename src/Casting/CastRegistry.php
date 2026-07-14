<?php

declare(strict_types=1);

namespace LaraGrid\Casting;

use LaraGrid\Casting\Casts\BoolCast;
use LaraGrid\Casting\Casts\DateCast;
use LaraGrid\Casting\Casts\DecimalCast;
use LaraGrid\Casting\Casts\IntCast;
use LaraGrid\Casting\Casts\SelectCast;
use LaraGrid\Casting\Casts\TextCast;
use LaraGrid\Columns\Column;

/**
 * What: The parse-kind registry — maps a column's parseSpec kind ('text', 'int', 'decimal',
 *       'select', 'bool', 'date', + app-registered kinds) to the Cast that produces the
 *       server-side model value.
 *
 * Why:  The extraction seam that removed the source app's Money::toPaise from the core editing
 *       path: core ships only the neutral kinds; an app registers its own (e.g. 'paise') from
 *       its service provider, paired with a JS parse twin. Bound as a container singleton so
 *       one registration is visible to every applier in the request.
 *
 * When: Registered as a singleton by LaraGridServiceProvider; consumed by OpApplier::castValue().
 */
class CastRegistry
{
    /** @var array<string, Cast> */
    private array $casts = [];

    public function __construct()
    {
        $this->register('text', new TextCast);
        $this->register('int', new IntCast);
        $this->register('decimal', new DecimalCast);
        $this->register('select', new SelectCast);
        $this->register('bool', new BoolCast);
        $this->register('date', new DateCast);
    }

    public function register(string $kind, Cast $cast): void
    {
        $this->casts[$kind] = $cast;
    }

    public function has(string $kind): bool
    {
        return isset($this->casts[$kind]);
    }

    /**
     * Cast a raw client value for the given kind. An unknown kind falls back to the 'text'
     * cast — mirroring the JS parse registry's fallback, so a config naming a kind neither
     * runtime knows still commits a trimmed string rather than crashing entry.
     *
     * @param  array<string, mixed>  $spec  The column's full parseSpec.
     */
    public function cast(string $kind, mixed $value, array $spec, Column $column): mixed
    {
        return ($this->casts[$kind] ?? $this->casts['text'])->cast($value, $spec, $column);
    }
}
