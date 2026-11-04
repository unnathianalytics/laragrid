/**
 * Node harness: run the shared arithmetic.json vectors (F1 calculator entry) through the REAL
 * parse.js casts — the JS half of the anti-drift pair whose PHP half is
 * tests/Feature/Grid/ArithmeticVectorsTest.php (CastRegistry int/decimal). `cases` must cast to
 * the committed int and decimal values; `malformed` rows must return the `undefined` refusal
 * sentinel from both casts, and refusalMessage() must name the problem. Also pins which kinds
 * the number editor opens to calculator keys: core int/decimal, and an app kind only when it
 * registers `arithmetic: true` (an app 'paise' that never evaluates keeps the plain keys).
 * Exits non-zero with a diff on any mismatch. Runnable directly:
 * `node tests/js/run-arithmetic-vectors.mjs`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..'); // tests/js -> repo root

const { parseInt10, parseDecimal, parseValue, refusalMessage, acceptsArithmetic, registerCast, evaluateArithmetic } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'format', 'parse.js')).href
);
const { FakeElement, installFakeDom } = await import(pathToFileURL(resolve(here, 'support', 'fake-dom.mjs')).href);

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

// Which kinds open the number editor to calculator keys.
registerCast('plainpaise', { parse: (raw) => Math.round(Number(raw) * 100) || 0 });
registerCast('calcpaise', {
    parse: (raw) => {
        const value = evaluateArithmetic(raw);
        return value === undefined ? undefined : Math.round((value ?? Number(raw)) * 100) || 0;
    },
    arithmetic: true,
});
check('arithmetic int', acceptsArithmetic({ kind: 'int' }), true);
check('arithmetic decimal', acceptsArithmetic({ kind: 'decimal', scale: 2 }), true);
check('arithmetic text', acceptsArithmetic({ kind: 'text' }), false);
check('arithmetic app kind without the flag', acceptsArithmetic({ kind: 'plainpaise' }), false);
check('arithmetic app kind with the flag', acceptsArithmetic({ kind: 'calcpaise' }), true);
check('calcpaise evaluates', parseValue({ kind: 'calcpaise' }, '1250*12'), 1500000);
check('calcpaise refuses', parseValue({ kind: 'calcpaise' }, '1+'), undefined);

// The real NumberEditor: calculator keys only where the cast evaluates them.
installFakeDom();
FakeElement.prototype.focus = function focus() {};
FakeElement.prototype.select = function select() {};
FakeElement.prototype.setSelectionRange = function setSelectionRange() {};
const { default: NumberEditor } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'edit', 'editors', 'NumberEditor.js')).href
);
const typed = (kind, data) => {
    const editor = new NumberEditor();
    editor.mount(new FakeElement(), { column: { key: 'x', parse: { kind } }, initialText: '', caretAtEnd: true });
    let refused = false;
    editor.onBeforeInput({ data, preventDefault: () => { refused = true; } });
    editor.destroy();
    return refused ? 'refused' : 'accepted';
};
check('editor decimal accepts *', typed('decimal', '*'), 'accepted');
check('editor decimal accepts (', typed('decimal', '('), 'accepted');
check('editor int accepts =', typed('int', '='), 'accepted');
check('editor app kind refuses *', typed('plainpaise', '*'), 'refused');
check('editor app kind refuses space', typed('plainpaise', ' '), 'refused');
check('editor app kind accepts digits', typed('plainpaise', '1,250.5-'), 'accepted');
check('editor flagged app kind accepts *', typed('calcpaise', '*'), 'accepted');
check('editor refuses letters', typed('decimal', 'a'), 'refused');

const total = vectors.cases.length * 2 + vectors.malformed.length * 2 + 23;

if (failures.length > 0) {
    console.error(`arithmetic vectors: ${pass}/${total}`);
    failures.forEach((f) => console.error('  FAIL ' + f));
    process.exit(1);
}

console.log(`arithmetic vectors: ${pass}/${total} passed`);
process.exit(0);
