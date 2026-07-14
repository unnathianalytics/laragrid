<?php

declare(strict_types=1);

namespace LaraGrid\Expression;

use InvalidArgumentException;

/**
 * What: The expression lexer — turns a formula source string into a flat list of Tokens
 *       (numbers, identifiers, operators, parens, commas, EOF).
 *
 * Why:  Splitting lexing from parsing keeps each simple: the lexer owns character-level concerns
 *       (multi-char operators like <=, decimal numbers, identifier characters) and the parser
 *       owns structure. It is deliberately tiny — the grammar is small and closed (plan §2.4) —
 *       and rejects an unknown character loudly so a malformed formula fails at build time, not
 *       as a silently-wrong client computation.
 *
 * When: Called by Parser::parse() before parsing.
 */
final class Lexer
{
    /** Recognised single/multi-char operators (multi-char first so <= isn't split into < =). */
    private const OPERATORS = ['==', '!=', '<=', '>=', '<', '>', '+', '-', '*', '/', '%'];

    /**
     * Tokenize a formula source into a list of tokens terminated by an Eof token.
     *
     * @return list<Token>
     *
     * @throws InvalidArgumentException On an unrecognised character.
     */
    public function tokenize(string $source): array
    {
        $tokens = [];
        $length = strlen($source);
        $i = 0;

        while ($i < $length) {
            $char = $source[$i];

            if (ctype_space($char)) {
                $i++;

                continue;
            }

            if ($char === '(') {
                $tokens[] = new Token(TokenType::LParen, '(', $i++);

                continue;
            }
            if ($char === ')') {
                $tokens[] = new Token(TokenType::RParen, ')', $i++);

                continue;
            }
            if ($char === ',') {
                $tokens[] = new Token(TokenType::Comma, ',', $i++);

                continue;
            }

            // Number: digits with an optional single decimal point.
            if (ctype_digit($char) || ($char === '.' && $i + 1 < $length && ctype_digit($source[$i + 1]))) {
                $start = $i;
                $seenDot = false;
                while ($i < $length && (ctype_digit($source[$i]) || (! $seenDot && $source[$i] === '.'))) {
                    if ($source[$i] === '.') {
                        $seenDot = true;
                    }
                    $i++;
                }
                $tokens[] = new Token(TokenType::Number, substr($source, $start, $i - $start), $start);

                continue;
            }

            // Identifier: letter/underscore then letters/digits/underscores (column keys, fn names).
            if (ctype_alpha($char) || $char === '_') {
                $start = $i;
                while ($i < $length && (ctype_alnum($source[$i]) || $source[$i] === '_')) {
                    $i++;
                }
                $tokens[] = new Token(TokenType::Identifier, substr($source, $start, $i - $start), $start);

                continue;
            }

            // Operators (multi-char before single-char).
            $matched = null;
            foreach (self::OPERATORS as $op) {
                if (substr($source, $i, strlen($op)) === $op) {
                    $matched = $op;
                    break;
                }
            }
            if ($matched !== null) {
                $tokens[] = new Token(TokenType::Operator, $matched, $i);
                $i += strlen($matched);

                continue;
            }

            throw new InvalidArgumentException("Unexpected character [{$char}] at position {$i} in expression.");
        }

        $tokens[] = new Token(TokenType::Eof, '', $length);

        return $tokens;
    }
}
