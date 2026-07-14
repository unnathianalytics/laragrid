/**
 * Node harness: run the shared expressions.json vectors through the REAL datagrid ExprEval module
 * (the JS half of the R2 anti-drift lock — the PHP half is ExpressionEngineTest). The AST in each
 * vector was produced by the PHP Parser (the sole parser), so this proves the JS evaluator walks
 * that exact tree to the same value PHP computed. Also spot-checks parse.js casts. Exits non-zero
 * with a diff on any mismatch. Invoked by tests/Feature/Grid/ExpressionVectorsTest.php via Symfony
 * Process (skipped when node is unavailable) and runnable directly:
 * `node tests/js/run-expression-vectors.mjs`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..'); // tests/js -> repo root
const jsBase = resolve(root, 'resources', 'js');

const { evaluate } = await import(pathToFileURL(resolve(jsBase, 'formula', 'ExprEval.js')).href);
const { parseDecimal, parseInt10, parseText, roundHalfUp, stripGrouping } = await import(
    pathToFileURL(resolve(jsBase, 'format', 'parse.js')).href
);

// 'paise' left core in the extraction (app-registered cast); these vectors keep pinning the
// REFERENCE implementation an app registers via registerCast('paise', ...) — see docs/recipes.
const parsePaise = (raw) => {
    const normalised = stripGrouping(raw);
    if (normalised === '' || Number.isNaN(Number(normalised))) {
        return 0;
    }
    return roundHalfUp(Number(normalised) * 100, 0);
};

const vectors = JSON.parse(
    readFileSync(resolve(root, 'tests', 'fixtures', 'grid-vectors', 'expressions.json'), 'utf8'),
);

let pass = 0;
const failures = [];

// Expression vectors: walk each committed AST and compare to the committed expected value.
for (const v of vectors) {
    const got = evaluate(v.ast, v.scope || {});
    // Compare with a tiny tolerance for fp; the values are money/qty scale where PHP and JS agree.
    const ok = Math.abs(got - v.expected) < 1e-9;
    if (ok) {
        pass++;
    } else {
        failures.push(`[${v.expr}] over ${JSON.stringify(v.scope)} -> got ${got} want ${v.expected}`);
    }
}
const exprCount = vectors.length;

// Parse spot-checks: the JS casts must mirror the server (OpApplier::castValue). A small,
// deterministic set — the shared expression fixture doesn't cover parsing, so pin the casts here.
const parseCases = [
    ['paise "1,250.50"', () => parsePaise('1,250.50'), 125050],
    ['paise "1000"', () => parsePaise('1000'), 100000],
    ['paise blank', () => parsePaise(''), 0],
    ['decimal "3" @3', () => parseDecimal('3', 3), '3.000'],
    ['decimal "2.3456" @2', () => parseDecimal('2.3456', 2), '2.35'],
    ['decimal "1,00,000.5" @3', () => parseDecimal('1,00,000.5', 3), '100000.500'],
    ['int "1,250"', () => parseInt10('1,250'), 1250],
    ['int "12.7"', () => parseInt10('12.7'), 13],
    ['text "  Bolt  "', () => parseText('  Bolt  ', null), 'Bolt'],
    ['text upper', () => parseText('abc', 'upper'), 'ABC'],
];
let parsePass = 0;
for (const [label, fn, want] of parseCases) {
    const got = fn();
    if (got === want) {
        parsePass++;
    } else {
        failures.push(`parse ${label} -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
}

if (failures.length > 0) {
    console.error(`expression vectors: ${pass}/${exprCount}, parse: ${parsePass}/${parseCases.length}`);
    failures.forEach((f) => console.error('  FAIL ' + f));
    process.exit(1);
}

console.log(`expression vectors: ${pass}/${exprCount} passed; parse: ${parsePass}/${parseCases.length} passed`);
process.exit(0);
