/**
 * Node harness: run the shared navigation.json vectors through the REAL datagrid geometry +
 * keymap modules (the M2 half of the anti-drift lock, mirroring how M1 proved formatters.js in
 * Node). It also pins intentionally unassigned keys at the dispatcher boundary. Exits non-zero
 * with a diff on any mismatch. Invoked by tests/Feature/Grid/
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
const { default: KeyboardManager } = await import(
    pathToFileURL(resolve(jsBase, 'keyboard', 'KeyboardManager.js')).href,
);

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

// A free key must pass through the full dispatcher untouched even on editable grids. Checking
// both presets catches either a future direct edit-open gesture or an accidental keymap binding.
const originalDocument = globalThis.document;
try {
    const root = { contains: () => false };
    globalThis.document = { activeElement: root };

    for (const keymap of ['entry', 'excel']) {
        const binding = keymapFor(keymap).F2;
        let prevented = false;
        let opened = false;
        const manager = new KeyboardManager(
            { layout: { keymap } },
            {},
            { root },
            { editor: { isEditing: () => false, open: () => { opened = true; } } },
        );
        manager.handleKeyDown({
            key: 'F2',
            target: root,
            preventDefault: () => { prevented = true; },
        });

        if (binding !== undefined || prevented || opened) {
            failures.push(
                `[${keymap}] F2 must remain unhandled `
                + `(binding=${JSON.stringify(binding)}, prevented=${prevented}, opened=${opened})`,
            );
        }
    }
} finally {
    if (originalDocument === undefined) {
        delete globalThis.document;
    } else {
        globalThis.document = originalDocument;
    }
}

if (failures.length > 0) {
    console.error(`navigation vectors: ${pass}/${data.vectors.length} passed`);
    failures.forEach((f) => console.error('  FAIL ' + f));
    process.exit(1);
}

console.log(`navigation vectors: ${pass}/${data.vectors.length} passed; F2 is unhandled`);
process.exit(0);
