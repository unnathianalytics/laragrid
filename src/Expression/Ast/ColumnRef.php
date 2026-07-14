<?php

declare(strict_types=1);

namespace LaraGrid\Expression\Ast;

/**
 * What: A reference to another column's value (qty, rate, discount) resolved against the row scope
 *       at evaluation time.
 *
 * Why:  A formula's whole point is to combine sibling cells; the ref names the row key to read.
 *       The evaluator coerces the referenced value to a number (paise int, decimal string, etc.),
 *       so the formula grammar stays numeric while columns carry their native model type.
 *
 * When: Emitted by the Parser for an IDENTIFIER token that isn't a function name.
 */
final class ColumnRef extends Node
{
    public function __construct(public readonly string $name) {}

    /**
     * @return array{t: string, k: string}
     */
    public function toArray(): array
    {
        return ['t' => 'col', 'k' => $this->name];
    }
}
