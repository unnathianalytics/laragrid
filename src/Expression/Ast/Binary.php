<?php

declare(strict_types=1);

namespace LaraGrid\Expression\Ast;

/**
 * What: A binary operation node: arithmetic (+ - * / %) or comparison (== != < <= > >=).
 *
 * Why:  The bulk of a formula is binary arithmetic; comparisons feed if(cond, a, b). Storing the
 *       operator as a string keeps the wire shape tiny and the evaluator a single switch — the
 *       same switch ExprEval.js implements.
 *
 * When: Emitted by the Parser's led (left-denotation) for an infix operator.
 */
final class Binary extends Node
{
    public function __construct(
        public readonly string $op,
        public readonly Node $left,
        public readonly Node $right,
    ) {}

    /**
     * @return array{t: string, op: string, l: array<string, mixed>, r: array<string, mixed>}
     */
    public function toArray(): array
    {
        return [
            't' => 'bin',
            'op' => $this->op,
            'l' => $this->left->toArray(),
            'r' => $this->right->toArray(),
        ];
    }
}
