<?php

declare(strict_types=1);

namespace LaraGrid\Expression;

/**
 * What: The lexical token kinds the Lexer emits and the Parser consumes.
 *
 * Why:  A closed enum of token kinds keeps the lexer/parser boundary type-safe — the parser
 *       switches on a case, never a raw string, so an unhandled kind is a compile-time gap not a
 *       silent misparse.
 *
 * When: Produced by Lexer::tokenize(); read by Parser.
 */
enum TokenType
{
    case Number;
    case Identifier;
    case Operator;   // + - * / % and comparison operators
    case LParen;
    case RParen;
    case Comma;
    case Eof;
}
