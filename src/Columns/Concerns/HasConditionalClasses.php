<?php

declare(strict_types=1);

namespace LaraGrid\Columns\Concerns;

/**
 * What: Declarative conditional cell classes — `->classWhen('dc', 'C', 'is-credit')` paints this
 *       column's cells with a host class on every row whose sibling `dc` value is in the list.
 *
 * Why:  A `cellClass` closure is a server verdict the client only sees after a round trip; a
 *       declaration the client can evaluate follows the controlling value the instant the
 *       operator types (the lockedWhen pattern). Arbitrary logic stays in the closures.
 *
 * When: Mixed into Column; serialized as `classWhen` only when declared, so grids without it
 *       keep their committed config byte-identical.
 */
trait HasConditionalClasses
{
    /**
     * @var list<array{column: string, in: list<string>, class: string}>
     */
    protected array $classWhen = [];

    /**
     * Add `$class` to this column's cells on rows whose `$column` value is one of `$values`.
     * Repeatable; every matching declaration applies.
     *
     * @param  string  $column  The controlling column key (may be this column).
     * @param  string|array<int, string>  $values  Value(s) of `$column` that apply the class.
     * @param  string  $class  One or more space-separated host classes (never `lgrid-*`).
     */
    public function classWhen(string $column, string|array $values, string $class): static
    {
        $this->classWhen[] = [
            'column' => $column,
            'in' => array_values(array_map(fn ($value): string => (string) $value, (array) $values)),
            'class' => trim($class),
        ];

        return $this;
    }

    /**
     * @return list<array{column: string, in: list<string>, class: string}>
     */
    public function getClassWhen(): array
    {
        return $this->classWhen;
    }

    /**
     * @return array<string, list<array{column: string, in: list<string>, class: string}>>
     */
    protected function serializeClassWhen(): array
    {
        return $this->classWhen === [] ? [] : ['classWhen' => $this->classWhen];
    }
}
