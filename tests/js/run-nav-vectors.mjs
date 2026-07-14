/**
 * Node harness: run the shared navigation.json vectors through the REAL datagrid geometry +
 * keymap modules (the M2 half of the anti-drift lock, mirroring how M1 proved formatters.js in
 * Node). Exits non-zero with a diff on any mismatch. Invoked by tests/Feature/Grid/
 * NavigationVectorsTest.php via Symfony Process (skipped when node is unavailable) and runnable
 * directly: `node tests/js/run-nav-vectors.mjs`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..'); // tests/js -> repo root
const jsBase = resolve(root, 'resources', 'js');

const { resolveMove } = await import(pathToFileURL(resolve(jsBase, 'util', 'geometry.js')).href);
const { ENTRY_KEYMAP } = await import(pathToFileURL(resolve(jsBase, 'keyboard', 'keymap-entry.js')).href);
const { EXCEL_KEYMAP } = await import(pathToFileURL(resolve(jsBase, 'keyboard', 'keymap-excel.js')).href);

const keymapFor = (name) => (name === 'excel' ? EXCEL_KEYMAP : ENTRY_KEYMAP);

const data = JSON.parse(
    readFileSync(resolve(root, 'tests', 'fixtures', 'grid-vectors', 'navigation.json'), 'utf8'),
);

let pass = 0;
const failures = [];

for (const v of data.vectors) {
    const binding = keymapFor(v.keymap)[v.chord];
    if (!binding || (binding.action !== 'move' && binding.action !== 'select')) {
        failures.push(`no move binding for chord ${v.chord} (${v.keymap})`);
        continue;
    }
    const got = resolveMove({
        intent: binding.intent,
        row: v.start.row,
        col: v.start.col,
        rowCount: data.rowCount,
        mask: data.mask,
        page: data.page,
    });
    const want = v.expected;
    const ok =
        got.row === want.row &&
        got.col === want.col &&
        (got.escape || null) === (want.escape || null);

    if (ok) {
        pass++;
    } else {
        failures.push(
            `[${v.keymap}] ${v.chord} from (${v.start.row},${v.start.col}) -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
        );
    }
}

if (failures.length > 0) {
    console.error(`navigation vectors: ${pass}/${data.vectors.length} passed`);
    failures.forEach((f) => console.error('  FAIL ' + f));
    process.exit(1);
}

console.log(`navigation vectors: ${pass}/${data.vectors.length} passed`);
process.exit(0);
