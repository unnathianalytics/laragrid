<?php

declare(strict_types=1);

namespace LaraGrid\Casting;

use InvalidArgumentException;
use LaraGrid\Expression\Evaluator;
use LaraGrid\Expression\Lexer;
use LaraGrid\Expression\Parser;
use LaraGrid\Expression\TokenType;

/**
 * What: Calculator entry for number cells — evaluates operator-typed arithmetic text
 *       (`1250*12`, `(2+3)*4`, `=100*1.18`) through the formula engine's own Lexer, Parser and
 *       Evaluator, restricted to numbers, unary `+`/`-`, binary `+ - * /` and parentheses.
 *
 * Why:  Number cells send the operator's raw text on the wire and the server cast is
 *       authoritative, so the int and decimal casts must evaluate the same expression the JS
 *       twin (parse.js evaluateArithmetic) evaluated optimistically. The detection rule below is
 *       the JS rule verbatim; tests/fixtures/grid-vectors/arithmetic.json pins both.
 *
 * When: Called first by IntCast and DecimalCast.
 */
final class Arithmetic
{
    /**
     * Evaluate calculator text. Grouping (commas, whitespace) is stripped first, then one
     * leading `=`. Without `=`, the text is an expression only when it holds nothing but digits,
     * `.`, `+ - * / ( )` AND contains `+ * / ( )` or a `-` after a digit, `.` or `)`; a leading
     * `=` always means an expression. Division by zero is 0; a non-finite result is 0.
     *
     * @return float|null The value, or null when the text is not an expression (the caller
     *                    takes its plain number path).
     *
     * @throws InvalidArgumentException On a malformed expression (`1+`, `2(3)`, `=abc`).
     */
    public static function evaluate(mixed $value): ?float
    {
        if (! is_string($value)) {
            return null;
        }

        $text = (string) preg_replace('/[,\s]/u', '', $value);
        $explicit = str_starts_with($text, '=');
        $body = $explicit ? substr($text, 1) : $text;

        if (preg_match('/^[0-9.+\-*\/()]+$/', $body) !== 1) {
            if ($explicit) {
                throw new InvalidArgumentException('Not a valid number or expression.');
            }

            return null;
        }
        if (! $explicit && preg_match('/[+*\/()]|[0-9.)]-/', $body) !== 1) {
            return null;
        }

        foreach ((new Lexer)->tokenize($body) as $token) {
            $allowed = match ($token->type) {
                TokenType::Number, TokenType::LParen, TokenType::RParen, TokenType::Eof => true,
                TokenType::Operator => in_array($token->lexeme, ['+', '-', '*', '/'], true),
                default => false,
            };
            if (! $allowed) {
                throw new InvalidArgumentException("Unexpected token [{$token->lexeme}] in expression.");
            }
        }

        $result = (new Evaluator)->evaluate((new Parser)->parse($body), []);

        return is_finite($result) ? $result : 0.0;
    }
}
