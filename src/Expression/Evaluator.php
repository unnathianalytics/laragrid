<?php

declare(strict_types=1);

namespace LaraGrid\Expression;

use InvalidArgumentException;
use LaraGrid\Expression\Ast\Binary;
use LaraGrid\Expression\Ast\Call;
use LaraGrid\Expression\Ast\ColumnRef;
use LaraGrid\Expression\Ast\Node;
use LaraGrid\Expression\Ast\NumberLit;
use LaraGrid\Expression\Ast\Unary;

/**
 * What: The server-authoritative expression evaluator — walks an AST against a row scope and
 *       returns a float. The exact twin of ExprEval.js (client); their equality is pinned by
 *       tests/fixtures/grid-vectors/expressions.json.
 *
 * Why:  A formula's server result is the truth the ledger records (plan §2.1); the client value
 *       is cosmetic-until-reconciled. Both walkers must agree by construction, so this evaluator
 *       is a dumb switch over the node tags — no parsing, no app knowledge — and rounds half-up
 *       exactly as Money/round() do (plan G2). Column refs coerce to a number via toNumber() so a
 *       paise int, a decimal string, or a blank all evaluate predictably (blank → 0).
 *
 * When: Called by the OpApplier for every FormulaColumn whenever a dependency changes.
 */
final class Evaluator
{
    /**
     * Evaluate a node tree against a row scope (column key => raw model value).
     *
     * @param  array<string, mixed>  $scope
     */
    public function evaluate(Node $node, array $scope): float
    {
        return match (true) {
            $node instanceof NumberLit => $node->value,
            $node instanceof ColumnRef => $this->toNumber($scope[$node->name] ?? null),
            $node instanceof Unary => $this->unary($node, $scope),
            $node instanceof Binary => $this->binary($node, $scope),
            $node instanceof Call => $this->call($node, $scope),
            default => throw new InvalidArgumentException('Unknown expression node ['.$node::class.'].'),
        };
    }

    /**
     * @param  array<string, mixed>  $scope
     */
    private function unary(Unary $node, array $scope): float
    {
        $value = $this->evaluate($node->operand, $scope);

        return $node->op === '-' ? -$value : $value;
    }

    /**
     * @param  array<string, mixed>  $scope
     */
    private function binary(Binary $node, array $scope): float
    {
        $left = $this->evaluate($node->left, $scope);
        $right = $this->evaluate($node->right, $scope);

        return match ($node->op) {
            '+' => $left + $right,
            '-' => $left - $right,
            '*' => $left * $right,
            '/' => $right == 0.0 ? 0.0 : $left / $right,  // divide-by-zero → 0, never a crash/NaN
            '%' => $right == 0.0 ? 0.0 : fmod($left, $right),
            '==' => $left == $right ? 1.0 : 0.0,
            '!=' => $left != $right ? 1.0 : 0.0,
            '<' => $left < $right ? 1.0 : 0.0,
            '<=' => $left <= $right ? 1.0 : 0.0,
            '>' => $left > $right ? 1.0 : 0.0,
            '>=' => $left >= $right ? 1.0 : 0.0,
            default => throw new InvalidArgumentException("Unknown operator [{$node->op}]."),
        };
    }

    /**
     * @param  array<string, mixed>  $scope
     */
    private function call(Call $node, array $scope): float
    {
        $args = array_map(fn (Node $a): float => $this->evaluate($a, $scope), $node->args);

        return match ($node->fn) {
            'round' => $this->roundHalfUp($args[0], isset($args[1]) ? (int) $args[1] : 0),
            'min' => $args === [] ? 0.0 : min($args),
            'max' => $args === [] ? 0.0 : max($args),
            'abs' => abs($args[0]),
            'ceil' => (float) ceil($args[0]),
            'floor' => (float) floor($args[0]),
            'if' => $args[0] != 0.0 ? $args[1] : $args[2],
            default => throw new InvalidArgumentException("Unknown function [{$node->fn}]."),
        };
    }

    /**
     * Round half-up at $scale decimals — the app's money/GST rounding convention (plan G2).
     * PHP_ROUND_HALF_UP matches Money::toPaise (round()) and the JS ExprEval's rounding.
     */
    private function roundHalfUp(float $value, int $scale): float
    {
        return round($value, $scale, PHP_ROUND_HALF_UP);
    }

    /**
     * Coerce a raw model value to a number for arithmetic: null/blank → 0; a grouped/decimal
     * string strips commas; anything non-numeric → 0. Mirrors ExprEval.js toNumber().
     */
    private function toNumber(mixed $value): float
    {
        if ($value === null || $value === '') {
            return 0.0;
        }
        if (is_int($value) || is_float($value)) {
            return (float) $value;
        }
        $normalised = str_replace([',', ' '], '', (string) $value);

        return is_numeric($normalised) ? (float) $normalised : 0.0;
    }
}
