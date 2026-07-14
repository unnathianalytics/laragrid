<?php

declare(strict_types=1);

namespace LaraGrid\Expression\Ast;

/**
 * What: The base of the expression AST — the parsed tree a FormulaColumn ships in config and both
 *       evaluators (PHP Evaluator, JS ExprEval) walk.
 *
 * Why:  The AST is the R2 anti-drift device (plan §2.7): PHP is the ONLY parser; the tree is data;
 *       two dumb evaluators walk it. Every node serializes to a small tagged array ({t: …}) the
 *       client reproduces exactly — no logic crosses the wire, only structure. Keeping toArray()
 *       abstract forces every node to declare its wire shape, which the shared vectors then pin.
 *
 * When: Produced by Parser::parse(); consumed by Evaluator (server) and, via toArray(), by
 *       ExprEval.js (client).
 */
abstract class Node
{
    /**
     * The node's declarative wire shape ({t: <tag>, ...}). The `t` tag is what both evaluators
     * switch on; it must match the tags ExprEval.js knows.
     *
     * @return array<string, mixed>
     */
    abstract public function toArray(): array;
}
