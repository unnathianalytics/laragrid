<?php

declare(strict_types=1);

namespace LaraGrid\Expression\Ast;

/**
 * What: A numeric literal node (5, 0.09, 18).
 *
 * Why:  Literals are the leaves of arithmetic in a formula (rates, rounding scales). Stored as a
 *       float so the evaluator computes in doubles and rounds at assignment (plan G2).
 *
 * When: Emitted by the Parser for a NUMBER token.
 */
final class NumberLit extends Node
{
    public function __construct(public readonly float $value) {}

    /**
     * @return array{t: string, v: float}
     */
    public function toArray(): array
    {
        return ['t' => 'num', 'v' => $this->value];
    }
}
