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
 * What: A Pratt (precedence-climbing) parser turning the lexer's tokens into the expression AST.
 *
 * Why:  This is the SOLE parser in the system (plan §2.7 / R2): the AST it produces ships in
 *       config and both evaluators just walk it, so the client never parses arbitrary text
 *       (CSP-safe, no eval) and PHP↔JS can't drift in parsing. Pratt parsing keeps operator
 *       precedence/associativity in a small binding-power table rather than a nest of grammar
 *       methods — the whole parser is a few dozen lines for the closed grid grammar.
 *
 * When: FormulaColumn::ast() calls parse() at serialize time; ExpressionEngineTest exercises it
 *       directly and against the shared vectors.
 */
final class Parser
{
    /** The recognised call functions (name => required arity, or null for variadic min-1). */
    private const FUNCTIONS = [
        'round' => null,   // round(x) or round(x, scale)
        'min' => null,     // min(a, b, …)
        'max' => null,     // max(a, b, …)
        'abs' => 1,
        'ceil' => 1,
        'floor' => 1,
        'if' => 3,         // if(cond, then, else)
    ];

    /** Infix operator left-binding powers (higher binds tighter). */
    private const BINDING_POWER = [
        '==' => 10, '!=' => 10, '<' => 10, '<=' => 10, '>' => 10, '>=' => 10,
        '+' => 20, '-' => 20,
        '*' => 30, '/' => 30, '%' => 30,
    ];

    /** @var list<Token> */
    private array $tokens = [];

    private int $pos = 0;

    /**
     * Parse a formula source into an AST.
     *
     * @throws InvalidArgumentException On a syntax error (unexpected token, trailing input, …).
     */
    public function parse(string $source): Node
    {
        $this->tokens = (new Lexer)->tokenize($source);
        $this->pos = 0;

        $node = $this->parseExpression(0);

        if ($this->peek()->type !== TokenType::Eof) {
            $token = $this->peek();
            throw new InvalidArgumentException("Unexpected token [{$token->lexeme}] at position {$token->position}.");
        }

        return $node;
    }

    /**
     * Precedence-climbing core: parse a prefix operand, then absorb infix operators whose binding
     * power exceeds the caller's.
     */
    private function parseExpression(int $minBindingPower): Node
    {
        $left = $this->parsePrefix();

        while (true) {
            $token = $this->peek();
            if ($token->type !== TokenType::Operator) {
                break;
            }
            $bp = self::BINDING_POWER[$token->lexeme] ?? -1;
            if ($bp < $minBindingPower || $bp < 0) {
                break;
            }
            $this->advance();
            // Left-associative: right side parses with bp + 1 so equal operators nest left.
            $right = $this->parseExpression($bp + 1);
            $left = new Binary($token->lexeme, $left, $right);
        }

        return $left;
    }

    /**
     * Parse a prefix position: number, unary +/-, parenthesised group, column ref, or call.
     */
    private function parsePrefix(): Node
    {
        $token = $this->advance();

        switch ($token->type) {
            case TokenType::Number:
                return new NumberLit((float) $token->lexeme);

            case TokenType::Operator:
                if ($token->lexeme === '-' || $token->lexeme === '+') {
                    // Unary binds tighter than * so -a*b == (-a)*b.
                    $operand = $this->parseExpression(40);

                    return new Unary($token->lexeme, $operand);
                }
                throw new InvalidArgumentException("Unexpected operator [{$token->lexeme}] at position {$token->position}.");
            case TokenType::LParen:
                $node = $this->parseExpression(0);
                $this->expect(TokenType::RParen, ')');

                return $node;

            case TokenType::Identifier:
                if ($this->peek()->type === TokenType::LParen) {
                    return $this->parseCall($token->lexeme, $token->position);
                }

                return new ColumnRef($token->lexeme);

            default:
                throw new InvalidArgumentException("Unexpected token [{$token->lexeme}] at position {$token->position}.");
        }
    }

    /**
     * Parse a function call: name '(' args? ')'. Validates the function name and arity.
     */
    private function parseCall(string $name, int $position): Node
    {
        if (! array_key_exists($name, self::FUNCTIONS)) {
            throw new InvalidArgumentException("Unknown function [{$name}] at position {$position}.");
        }

        $this->expect(TokenType::LParen, '(');
        $args = [];
        if ($this->peek()->type !== TokenType::RParen) {
            $args[] = $this->parseExpression(0);
            while ($this->peek()->type === TokenType::Comma) {
                $this->advance();
                $args[] = $this->parseExpression(0);
            }
        }
        $this->expect(TokenType::RParen, ')');

        $arity = self::FUNCTIONS[$name];
        if ($arity !== null && count($args) !== $arity) {
            throw new InvalidArgumentException(
                "Function [{$name}] expects {$arity} argument(s), got ".count($args).'.'
            );
        }
        if ($name === 'round' && ! in_array(count($args), [1, 2], true)) {
            throw new InvalidArgumentException('round() expects 1 or 2 arguments.');
        }
        if (in_array($name, ['min', 'max'], true) && count($args) < 1) {
            throw new InvalidArgumentException("{$name}() expects at least 1 argument.");
        }

        return new Call($name, $args);
    }

    private function peek(): Token
    {
        return $this->tokens[$this->pos];
    }

    private function advance(): Token
    {
        return $this->tokens[$this->pos++];
    }

    private function expect(TokenType $type, string $lexeme): void
    {
        $token = $this->peek();
        if ($token->type !== $type) {
            throw new InvalidArgumentException("Expected [{$lexeme}] at position {$token->position}, got [{$token->lexeme}].");
        }
        $this->advance();
    }
}
