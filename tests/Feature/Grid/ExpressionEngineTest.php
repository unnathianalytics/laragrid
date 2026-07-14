<?php

declare(strict_types=1);

use LaraGrid\Expression\Ast\Binary;
use LaraGrid\Expression\Ast\Call;
use LaraGrid\Expression\Ast\ColumnRef;
use LaraGrid\Expression\Ast\NumberLit;
use LaraGrid\Expression\Evaluator;
use LaraGrid\Expression\Lexer;
use LaraGrid\Expression\Parser;
use LaraGrid\Expression\TokenType;

/**
 * What: Unit-tests the expression Lexer/Parser/Evaluator and asserts the PHP evaluator reproduces
 *       every shared expression vector's committed `expected` AND `ast`.
 *
 * Why:  The expression engine is one of only two dual-runtime pieces (plan R2). expressions.json is
 *       the anti-drift contract: this test locks the PHP parser (AST shape) and evaluator (value)
 *       to the fixture, and the JS ExprEval is run over the SAME fixture by run-expression-vectors.mjs
 *       (Step 7). If either runtime's behaviour changes, one of the two sides fails first, forcing
 *       the vectors (and both runtimes) to move together.
 */
it('lexes operators, numbers, identifiers, parens and commas', function () {
    $tokens = (new Lexer)->tokenize('round(qty * 2.5, 2)');

    $types = array_map(fn ($t) => $t->type, $tokens);

    expect($types)->toBe([
        TokenType::Identifier, // round
        TokenType::LParen,
        TokenType::Identifier, // qty
        TokenType::Operator,   // *
        TokenType::Number,     // 2.5
        TokenType::Comma,
        TokenType::Number,     // 2
        TokenType::RParen,
        TokenType::Eof,
    ]);
});

it('rejects an unknown character', function () {
    (new Lexer)->tokenize('qty @ rate');
})->throws(InvalidArgumentException::class);

it('parses precedence, associativity and unary correctly', function () {
    $parser = new Parser;

    // 2 + 3 * 4  →  +(2, *(3,4))
    $ast = $parser->parse('2 + 3 * 4');
    expect($ast)->toBeInstanceOf(Binary::class)
        ->and($ast->op)->toBe('+')
        ->and($ast->right)->toBeInstanceOf(Binary::class)
        ->and($ast->right->op)->toBe('*');

    // qty reference + literal
    $ast = $parser->parse('qty * 5');
    expect($ast->left)->toBeInstanceOf(ColumnRef::class)
        ->and($ast->left->name)->toBe('qty')
        ->and($ast->right)->toBeInstanceOf(NumberLit::class);

    // function call node
    $ast = $parser->parse('round(qty, 2)');
    expect($ast)->toBeInstanceOf(Call::class)
        ->and($ast->fn)->toBe('round')
        ->and($ast->args)->toHaveCount(2);
});

it('rejects an unknown function, wrong arity, and unbalanced parens', function () {
    $parser = new Parser;

    expect(fn () => $parser->parse('sqrt(4)'))->toThrow(InvalidArgumentException::class);
    expect(fn () => $parser->parse('abs(1, 2)'))->toThrow(InvalidArgumentException::class);
    expect(fn () => $parser->parse('if(a, b)'))->toThrow(InvalidArgumentException::class);
    expect(fn () => $parser->parse('(2 + 3'))->toThrow(InvalidArgumentException::class);
    expect(fn () => $parser->parse('2 + 3)'))->toThrow(InvalidArgumentException::class);
});

it('rounds half-up at the target scale (money/GST convention, G2)', function () {
    $parser = new Parser;
    $evaluator = new Evaluator;

    expect($evaluator->evaluate($parser->parse('round(2.5, 0)'), []))->toBe(3.0)
        ->and($evaluator->evaluate($parser->parse('round(2.345, 2)'), []))->toBe(2.35)
        ->and($evaluator->evaluate($parser->parse('round(qty * rate, 2)'), ['qty' => '5.000', 'rate' => '12.50']))->toBe(62.5);
});

it('coerces column refs to numbers: blank → 0, grouped string strips commas, divide-by-zero → 0', function () {
    $parser = new Parser;
    $evaluator = new Evaluator;

    expect($evaluator->evaluate($parser->parse('missing + 5'), []))->toBe(5.0)
        ->and($evaluator->evaluate($parser->parse('amount / 0'), ['amount' => 50]))->toBe(0.0)
        ->and($evaluator->evaluate($parser->parse('a + b'), ['a' => '1,00,000', 'b' => '']))->toBe(100000.0);
});

it('reproduces every shared expression vector (PHP side): AST shape and value', function () {
    $parser = new Parser;
    $evaluator = new Evaluator;

    $path = dirname(__DIR__, 3).'/tests/fixtures/grid-vectors/expressions.json';
    expect(file_exists($path))->toBeTrue();

    /** @var list<array{expr: string, scope: array<string, mixed>, ast: array<string, mixed>, expected: int|float}> $vectors */
    $vectors = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);

    expect($vectors)->not->toBeEmpty();

    foreach ($vectors as $i => $vector) {
        $ast = $parser->parse($vector['expr']);
        $scope = (array) $vector['scope'];

        // Parser side: the produced AST matches the committed tree exactly (locks the parser).
        // Compared after a JSON round-trip — the shape that actually ships in config — so a float
        // literal 1.0 and the fixture's JSON 1 are the same representation (JSON has one number
        // type; the JS evaluator likewise treats them identically).
        $producedAst = json_decode((string) json_encode($ast->toArray()), true, flags: JSON_THROW_ON_ERROR);
        expect($producedAst)->toBe(
            $vector['ast'],
            "Vector #{$i} [{$vector['expr']}] AST drift."
        );

        // Evaluator side: the value matches the committed expected (locks the evaluator).
        expect($evaluator->evaluate($ast, $scope))->toBe(
            (float) $vector['expected'],
            "Vector #{$i} [{$vector['expr']}] value drift."
        );
    }
});
