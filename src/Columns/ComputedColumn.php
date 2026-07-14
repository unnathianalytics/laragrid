<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

use Closure;

/**
 * What: A display-only column whose value is derived server-side per row by a closure at
 *       serialize time, rather than read from a row key.
 *
 * Why:  Reports routinely show a value that isn't stored on the row (a label lookup, a
 *       derived flag, a concatenation). In M1 this is resolved authoritatively on the server
 *       during serialization and baked into the emitted row under this column's key, so the
 *       client still just paints row[key] — no client-side computation, no round-trip. (The
 *       dual client/server FormulaColumn arrives with the editing milestone; Computed stays
 *       server-only.)
 *
 * When: Any readonly derived column; the closure receives the raw host row array.
 */
final class ComputedColumn extends Column
{
    /**
     * @var (Closure(array<string, mixed>): mixed)|null
     */
    protected ?Closure $stateResolver = null;

    /**
     * Set the per-row value resolver.
     *
     * @param  Closure(array<string, mixed>): mixed  $resolver  Receives the host row, returns the display value.
     */
    public function state(Closure $resolver): static
    {
        $this->stateResolver = $resolver;

        return $this;
    }

    /**
     * Resolve this column's value for a given host row (server-side).
     *
     * @param  array<string, mixed>  $row
     */
    public function resolveState(array $row): mixed
    {
        return $this->stateResolver ? ($this->stateResolver)($row) : null;
    }

    public function hasResolver(): bool
    {
        return $this->stateResolver !== null;
    }

    protected function configureDefaults(): void
    {
        $this->defaultAlign('left');
    }

    public function painterId(): string
    {
        return 'text';
    }

    /**
     * @return array{computed: true}
     */
    protected function serializeType(): array
    {
        return ['computed' => true];
    }
}
