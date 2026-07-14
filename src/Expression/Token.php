<?php

declare(strict_types=1);

namespace LaraGrid\Expression;

/**
 * What: One lexical token — its kind plus the source lexeme (the literal text, e.g. "qty", "5",
 *       "*") and the source position (for clear parse-error messages).
 *
 * Why:  A plain immutable value object; the parser reads `type` to decide structure and `lexeme`
 *       to build leaf nodes / resolve operators. Position turns "unexpected token" into
 *       "unexpected ')' at 12", which matters because formula authors are app developers.
 *
 * When: Emitted by the Lexer.
 */
final class Token
{
    public function __construct(
        public readonly TokenType $type,
        public readonly string $lexeme,
        public readonly int $position,
    ) {}
}
