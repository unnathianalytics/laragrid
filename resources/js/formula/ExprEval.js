/**
 * LaraGrid — client expression evaluator (the JS twin of App\Grid\Expression\Evaluator).
 *
 * What: Walk an expression AST (shipped in config by the PHP Parser — the SOLE parser) against a
 *       row scope and return a number. The client never parses; it only evaluates.
 * Why:  A FormulaColumn recomputes on the client the instant a dependency changes (zero round-trip),
 *       then the server value wins on reconcile. This walker MUST agree with Evaluator.php by
 *       construction (plan §2.7, R2): same node tags, same operator/function semantics, same
 *       half-up rounding (G2), same toNumber coercion (blank → 0, grouped string strips commas,
 *       divide-by-zero → 0). Equality is pinned by tests/fixtures/grid-vectors/expressions.json,
 *       run in Node (run-expression-vectors.mjs) and PHP (ExpressionEngineTest).
 * When: Imported by the StateStore's formula recompute on every dependent cell change.
 */

/** Round half-up at `scale` decimals — mirrors PHP round(..., HALF_UP) and parse.js roundHalfUp. */
function roundHalfUp(value, scale) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const factor = Math.pow(10, scale);
    const shifted = value * factor;
    const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted) + 1e-9);
    return rounded / factor;
}

/** Coerce a raw model value to a number: null/'' → 0, grouped/decimal string strips commas. */
function toNumber(value) {
    if (value === null || value === undefined || value === '') {
        return 0;
    }
    if (typeof value === 'number') {
        return value;
    }
    const normalised = String(value).replace(/[,\s]/g, '');
    const n = Number(normalised);
    return Number.isNaN(n) ? 0 : n;
}

/**
 * Evaluate a serialized AST node against a scope (column key → raw model value).
 *
 * @param {object} node the tagged AST node ({t, ...})
 * @param {Object<string, *>} scope
 * @returns {number}
 */
export function evaluate(node, scope) {
    switch (node.t) {
        case 'num':
            return node.v;
        case 'col':
            return toNumber(scope[node.k]);
        case 'un':
            return node.op === '-' ? -evaluate(node.x, scope) : evaluate(node.x, scope);
        case 'bin':
            return binary(node, scope);
        case 'call':
            return call(node, scope);
        default:
            throw new Error(`Unknown expression node [${node.t}].`);
    }
}

function binary(node, scope) {
    const l = evaluate(node.l, scope);
    const r = evaluate(node.r, scope);
    switch (node.op) {
        case '+':
            return l + r;
        case '-':
            return l - r;
        case '*':
            return l * r;
        case '/':
            return r === 0 ? 0 : l / r;
        case '%':
            return r === 0 ? 0 : l % r;
        case '==':
            return l === r ? 1 : 0;
        case '!=':
            return l !== r ? 1 : 0;
        case '<':
            return l < r ? 1 : 0;
        case '<=':
            return l <= r ? 1 : 0;
        case '>':
            return l > r ? 1 : 0;
        case '>=':
            return l >= r ? 1 : 0;
        default:
            throw new Error(`Unknown operator [${node.op}].`);
    }
}

function call(node, scope) {
    const args = node.args.map((a) => evaluate(a, scope));
    switch (node.fn) {
        case 'round':
            return roundHalfUp(args[0], args.length > 1 ? Math.trunc(args[1]) : 0);
        case 'min':
            return args.length === 0 ? 0 : Math.min(...args);
        case 'max':
            return args.length === 0 ? 0 : Math.max(...args);
        case 'abs':
            return Math.abs(args[0]);
        case 'ceil':
            return Math.ceil(args[0]);
        case 'floor':
            return Math.floor(args[0]);
        case 'if':
            return args[0] !== 0 ? args[1] : args[2];
        default:
            throw new Error(`Unknown function [${node.fn}].`);
    }
}
