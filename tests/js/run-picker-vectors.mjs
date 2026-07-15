/**
 * Node harness: run the picker-parse.json vectors through the REAL datagrid parse.js module —
 * the M5 half of the R2 anti-drift lock for the picker kinds (date via the SHARED fuzzy parser,
 * bool, select) and for editTextFor (the F2/copy/paste interchange text, incl. the paise→rupee
 * round-trip that fixes the latent M4 F2 defect). The PHP cast mirrors are pinned by
 * OpApplierTest. Exits non-zero with a diff on any mismatch. Invoked by
 * tests/Feature/Grid/PickerVectorsTest.php via Symfony Process (skipped when node is
 * unavailable) and runnable directly: `node tests/js/run-picker-vectors.mjs`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..'); // tests/js -> repo root

const { parseDate, parseBool, parseYn, parseSelect, editTextFor , registerCast, stripGrouping, roundHalfUp } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'format', 'parse.js')).href
);

// 'paise' is an app-registered kind since the extraction — register the reference cast
// through the PUBLIC seam so all 46 vectors stay pinned AND the seam itself is proven.
registerCast('paise', {
    parse: (raw) => {
        const normalised = stripGrouping(raw);
        if (normalised === '' || Number.isNaN(Number(normalised))) {
            return 0;
        }
        return roundHalfUp(Number(normalised) * 100, 0);
    },
    editText: (value) => {
        const paise = Number(value);
        return Number.isFinite(paise) ? (paise / 100).toFixed(2) : '';
    },
});

const vectors = JSON.parse(
    readFileSync(resolve(root, 'tests', 'fixtures', 'grid-vectors', 'picker-parse.json'), 'utf8'),
);

let pass = 0;
const failures = [];

const check = (label, got, expected) => {
    // '__unparseable__' in the fixture marks the `undefined` refuse-the-commit sentinel.
    const want = expected === '__unparseable__' ? undefined : expected;
    if (got === want) {
        pass++;
    } else {
        failures.push(`${label} -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
};

for (const v of vectors.date) {
    check(
        `date ${JSON.stringify(v.raw)}`,
        parseDate(v.raw, { fyStartMonth: v.fyStartMonth, fyStartYear: v.fyStartYear }),
        v.expected,
    );
}

for (const v of vectors.bool) {
    check(`bool ${JSON.stringify(v.raw)}`, parseBool(v.raw), v.expected);
}

for (const v of vectors.yn) {
    check(`yn ${JSON.stringify(v.raw)}`, parseYn(v.raw), v.expected);
}

for (const v of vectors.select) {
    check(`select ${JSON.stringify(v.raw)}`, parseSelect(v.raw), v.expected);
}

for (const v of vectors.editText) {
    check(
        `editText ${v.parse.kind} ${JSON.stringify(v.value)}`,
        editTextFor({ parse: v.parse }, v.value),
        v.expected,
    );
}

const total =
    vectors.date.length + vectors.bool.length + vectors.yn.length
    + vectors.select.length + vectors.editText.length;

if (failures.length > 0) {
    console.error(`picker vectors: ${pass}/${total}`);
    failures.forEach((f) => console.error('  FAIL ' + f));
    process.exit(1);
}

console.log(`picker vectors: ${pass}/${total} passed`);
process.exit(0);
