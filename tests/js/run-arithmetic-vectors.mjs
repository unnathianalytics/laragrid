/**
 * Node harness: run the shared arithmetic.json vectors (F1 calculator entry) through the REAL
 * parse.js casts — the JS half of the anti-drift pair whose PHP half is
 * tests/Feature/Grid/ArithmeticVectorsTest.php (CastRegistry int/decimal). `cases` must cast to
 * the committed int and decimal values; `malformed` rows must return the `undefined` refusal
 * sentinel from both casts, and refusalMessage() must name the problem. Exits non-zero with a
 * diff on any mismatch. Runnable directly: `node tests/js/run-arithmetic-vectors.mjs`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..'); // tests/js -> repo root

const { parseInt10, parseDecimal, parseValue, refusalMessage } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'format', 'parse.js')).href
);

const vectors = JSON.parse(
    readFileSync(resolve(root, 'tests', 'fixtures', 'grid-vectors', 'arithmetic.json'), 'utf8'),
);

let pass = 0;
const failures = [];

const check = (label, got, want) => {
    if (got === want) {
        pass++;
    } else {
        failures.push(`${label} -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
};

for (const v of vectors.cases) {
    check(`int ${JSON.stringify(v.raw)}`, parseInt10(v.raw), v.int);
    check(`decimal@${v.scale} ${JSON.stringify(v.raw)}`, parseDecimal(v.raw, v.scale), v.decimal);
}

for (const v of vectors.malformed) {
    check(`int malformed ${JSON.stringify(v.raw)}`, parseInt10(v.raw), undefined);
    check(`decimal malformed ${JSON.stringify(v.raw)}`, parseDecimal(v.raw, v.scale), undefined);
}

// The registry path the editor uses, and the message it shows for each refusing kind.
check('parseValue int', parseValue({ kind: 'int' }, '1250*12'), 15000);
check('parseValue decimal', parseValue({ kind: 'decimal', scale: 2 }, '=100*1.18'), '118.00');
check('parseValue decimal malformed', parseValue({ kind: 'decimal', scale: 2 }, '1+'), undefined);
check('refusal int', refusalMessage({ kind: 'int' }), 'Not a valid number or expression.');
check('refusal decimal', refusalMessage({ kind: 'decimal', scale: 2 }), 'Not a valid number or expression.');
check('refusal date', refusalMessage({ kind: 'date' }), 'Not a recognisable date.');
check('refusal unknown kind', refusalMessage({ kind: 'nope' }), 'Not a valid value.');
// A text cell never evaluates: the operator's text is the value.
check('text keeps expression text', parseValue({ kind: 'text' }, '1250*12'), '1250*12');

const total = vectors.cases.length * 2 + vectors.malformed.length * 2 + 8;

if (failures.length > 0) {
    console.error(`arithmetic vectors: ${pass}/${total}`);
    failures.forEach((f) => console.error('  FAIL ' + f));
    process.exit(1);
}

console.log(`arithmetic vectors: ${pass}/${total} passed`);
process.exit(0);
