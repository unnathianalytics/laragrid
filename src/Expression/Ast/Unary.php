<?php

declare(strict_types=1);

namespace LaraGrid\Expression\Ast;

/**
 * What: A prefix unary operation node — negation (-x) or unary plus (+x).
 *
 * Why:  Formulas carry negatives (a credit column subtracting, -discount). Modelling unary minus
 *       as its own node (rather than 0 - x) keeps parsing precedence clean and the wire shape
 *       explicit for the client evaluator.
 *
 * When: Emitted by the Parser's nud (null-denotation) for a leading + or -.
 */
final class Unary extends Node
{
    public function __construct(
        public readonly string $op,
        public readonly Node $operand,
    ) {}

    /**
     * @return array{t: string, op: string, x: array<string, mixed>}
     */
    public function toArray(): array
    {
        return ['t' => 'un', 'op' => $this->op, 'x' => $this->operand->toArray()];
    }
}
