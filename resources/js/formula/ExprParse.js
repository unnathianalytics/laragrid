/**
 * LaraGrid — client arithmetic parser (the numeric subset of LaraGrid\Expression\Parser).
 *
 * What: Parse an operator-typed arithmetic text (`1250*12`, `(2+3)*4`, `-5-3`) into the SAME
 *       tagged AST the PHP Parser ships for formulas (`num`, `un`, `bin`), so ExprEval.evaluate
 *       walks it unchanged. Numbers, unary `+`/`-`, binary `+ - * /` and parentheses only — no
 *       column refs, calls, `%` or comparisons (a calculator entry, not a formula).
 * Why:  Calculator entry in number cells (plan F1) must yield the value the server cast
 *       computes from the same raw text. Formulas keep their single PHP parser; this one parses a
 *       closed numeric grammar whose tokenizing and binding powers copy Lexer.php / Parser.php
 *       (`+ -` 20, `* /` 30, unary 40, left-associative), pinned by arithmetic.json in both
 *       runtimes.
 * When: Called by parse.js evaluateArithmetic() on int/decimal commit and paste.
 */

/** Infix left-binding powers — Parser::BINDING_POWER restricted to the calculator operators. */
const BINDING_POWER = { '+': 20, '-': 20, '*': 30, '/': 30 };

/** Unary binding power — Parser::parsePrefix parses its operand at 40 (so -a*b == (-a)*b). */
const UNARY_POWER = 40;

const isDigit = (ch) => ch >= '0' && ch <= '9';

/**
 * Tokenize like Lexer::tokenize for the calculator alphabet: a number is digits with at most one
 * point (a leading point needs a digit after it); `( ) + - * /` are single tokens; whitespace is
 * skipped; anything else throws.
 *
 * @param {string} source
 * @returns {Array<{type: 'num'|'op'|'lparen'|'rparen'|'eof', lexeme: string, position: number}>}
 */
function tokenize(source) {
    const tokens = [];
    const length = source.length;
    let i = 0;

    while (i < length) {
        const ch = source[i];

        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === '(' || ch === ')') {
            tokens.push({ type: ch === '(' ? 'lparen' : 'rparen', lexeme: ch, position: i++ });
            continue;
        }
        if (isDigit(ch) || (ch === '.' && i + 1 < length && isDigit(source[i + 1]))) {
            const start = i;
            let seenDot = false;
            while (i < length && (isDigit(source[i]) || (!seenDot && source[i] === '.'))) {
                if (source[i] === '.') {
                    seenDot = true;
                }
                i++;
            }
            tokens.push({ type: 'num', lexeme: source.slice(start, i), position: start });
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(BINDING_POWER, ch)) {
            tokens.push({ type: 'op', lexeme: ch, position: i++ });
            continue;
        }

        throw new Error(`Unexpected character [${ch}] at position ${i} in expression.`);
    }

    tokens.push({ type: 'eof', lexeme: '', position: length });
    return tokens;
}

/**
 * Parse calculator text into a tagged AST. Throws on any syntax error (trailing operator,
 * unbalanced parenthesis, two adjacent operands, empty input).
 *
 * @param {string} source
 * @returns {object} the AST root ({t: 'num'|'un'|'bin', ...})
 */
export function parseArithmetic(source) {
    const tokens = tokenize(String(source));
    let pos = 0;

    const peek = () => tokens[pos];
    const advance = () => tokens[pos++];

    const parseExpression = (minBindingPower) => {
        let left = parsePrefix();

        for (;;) {
            const token = peek();
            if (token.type !== 'op') {
                break;
            }
            const bp = BINDING_POWER[token.lexeme];
            if (bp < minBindingPower) {
                break;
            }
            advance();
            // Left-associative: the right side parses at bp + 1 so equal operators nest left.
            const right = parseExpression(bp + 1);
            left = { t: 'bin', op: token.lexeme, l: left, r: right };
        }

        return left;
    };

    const parsePrefix = () => {
        const token = advance();

        switch (token.type) {
            case 'num':
                return { t: 'num', v: Number(token.lexeme) };
            case 'op':
                if (token.lexeme === '-' || token.lexeme === '+') {
                    return { t: 'un', op: token.lexeme, x: parseExpression(UNARY_POWER) };
                }
                throw new Error(`Unexpected operator [${token.lexeme}] at position ${token.position}.`);
            case 'lparen': {
                const node = parseExpression(0);
                const close = peek();
                if (close.type !== 'rparen') {
                    throw new Error(`Expected [)] at position ${close.position}, got [${close.lexeme}].`);
                }
                advance();
                return node;
            }
            default:
                throw new Error(`Unexpected token [${token.lexeme}] at position ${token.position}.`);
        }
    };

    const node = parseExpression(0);

    if (peek().type !== 'eof') {
        const token = peek();
        throw new Error(`Unexpected token [${token.lexeme}] at position ${token.position}.`);
    }

    return node;
}
