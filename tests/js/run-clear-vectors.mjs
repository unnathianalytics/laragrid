/**
 * Node harness: pins the Excel DELETE clear and the Ctrl+D fill-down against the REAL
 * StateStore + GridCore command path.
 *
 *   1. selectedCellAddresses() yields stable {rowKey, colKey} pairs for a range, and falls
 *      back to the active cell when there is no range.
 *   2. GridCore.clearSelectedCells() clears every selected EDITABLE cell through the shared
 *      paste pipeline and flushes ONE batch — non-editable columns are skipped.
 *   3. A cell locked for its row (lockedWhen) is skipped by the clear AND by fillDown().
 *
 * Invoke directly: `node tests/js/run-clear-vectors.mjs` (also part of `npm test`).
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);

const { default: GridCore } = await load('core/GridCore.js');

/** A voucher-like editable grid: dr/cr are locked by the dc side. */
function rig() {
    const config = {
        name: 'voucher',
        columns: [
            { key: '_serial', visible: true, editable: false, writable: false, navigable: false },
            { key: 'account', visible: true, editable: true, writable: true, navigable: true },
            { key: 'dc', visible: true, editable: true, writable: true, navigable: true },
            { key: 'dr', visible: true, editable: true, writable: true, navigable: true, lockedWhen: { column: 'dc', in: ['C'] } },
            { key: 'cr', visible: true, editable: true, writable: true, navigable: true, lockedWhen: { column: 'dc', in: ['D'] } },
        ],
        layout: { editable: true },
        rows: [
            { _k: 'r1', account: 'Cash', dc: 'D', dr: '100', cr: null },
            { _k: 'r2', account: 'Sales', dc: 'C', dr: null, cr: '100' },
            { _k: 'r3', account: 'Bank', dc: 'D', dr: '50', cr: null },
        ],
    };
    const core = new GridCore(config, { root: {} });
    const pasted = [];
    const batches = [];
    const messages = [];
    core.editorManager = {
        pasteCell(rowKey, colKey, column, raw) {
            pasted.push(`${rowKey}.${colKey}=${JSON.stringify(raw)}`);
            const cells = core.store.applyLocalSet(rowKey, colKey, raw === '' ? null : raw);
            return { ok: true, op: { t: 'set', row: rowKey, col: colKey, v: null }, cells };
        },
    };
    core.sync = { enqueueBatch: (items) => batches.push(items) };
    core.announcer = { message: (m) => messages.push(m) };
    return { core, store: core.store, pasted, batches, messages };
}

function selectRange(store, from, to) {
    store.setActive(from);
    store.setActive(to, { keepAnchor: true, kind: 'range' });
}

const failures = [];
async function scenario(name, fn) {
    try {
        await fn();
        console.log(`  ok    ${name}`);
    } catch (error) {
        failures.push(`${name}: ${error.message}`);
        console.error(`  FAIL  ${name} — ${error.message}`);
    }
}

await scenario('selectedCellAddresses yields stable addresses for a range', () => {
    const { store } = rig();
    selectRange(store, { rowKey: 'r1', colKey: 'account' }, { rowKey: 'r2', colKey: 'dc' });
    assert.deepEqual(store.selectedCellAddresses(), [
        { rowKey: 'r1', colKey: 'account' }, { rowKey: 'r1', colKey: 'dc' },
        { rowKey: 'r2', colKey: 'account' }, { rowKey: 'r2', colKey: 'dc' },
    ]);
    assert.equal(store.selectedCells().length, 2, 'the {column,value} reader shape is unchanged');
});

await scenario('selectedCellAddresses falls back to the active cell', () => {
    const { store } = rig();
    assert.deepEqual(store.selectedCellAddresses(), [], 'nothing active → nothing selected');
    store.setActive({ rowKey: 'r3', colKey: 'dr' });
    assert.deepEqual(store.selectedCellAddresses(), [{ rowKey: 'r3', colKey: 'dr' }]);
});

await scenario('Delete clears every selected editable cell in one batch', () => {
    const { core, store, pasted, batches, messages } = rig();
    // A row-wide range that also spans the non-editable serial gutter.
    selectRange(store, { rowKey: 'r1', colKey: 'account' }, { rowKey: 'r2', colKey: 'dc' });
    store.selection = { ...store.selection, c0: 0 }; // widen onto the gutter column
    core.clearSelectedCells();

    assert.deepEqual(pasted, [
        'r1.account=""', 'r1.dc=""', 'r2.account=""', 'r2.dc=""',
    ], 'editable cells only, in row-major order');
    assert.equal(batches.length, 1, 'one batch for the whole clear');
    assert.equal(batches[0].length, 4);
    assert.equal(store.rowByKey.get('r1').row.account, null);
    assert.equal(store.rowByKey.get('r2').row.dc, null);
    assert.deepEqual(messages, ['4 cells cleared.']);
});

await scenario('Delete clears only the active cell when nothing is ranged', () => {
    const { core, store, pasted, messages } = rig();
    store.setActive({ rowKey: 'r3', colKey: 'account' });
    core.clearSelectedCells();
    assert.deepEqual(pasted, ['r3.account=""']);
    assert.deepEqual(messages, ['Cell cleared.']);
});

await scenario('Delete skips cells locked for their row', () => {
    const { core, store, pasted, batches } = rig();
    // The whole dr column: r2 (dc='C') is locked, r1 and r3 are not.
    selectRange(store, { rowKey: 'r1', colKey: 'dr' }, { rowKey: 'r3', colKey: 'dr' });
    core.clearSelectedCells();
    assert.deepEqual(pasted, ['r1.dr=""', 'r3.dr=""']);
    assert.equal(store.rowByKey.get('r2').row.dr, null, 'locked cell untouched');
    assert.equal(batches[0].length, 2);
});

await scenario('Delete with nothing editable selected flushes nothing', () => {
    const { core, store, pasted, batches, messages } = rig();
    store.setActive({ rowKey: 'r2', colKey: 'dr' }); // locked
    core.clearSelectedCells();
    assert.deepEqual(pasted, []);
    assert.equal(batches.length, 0);
    assert.deepEqual(messages, []);
});

await scenario('fillDown skips a locked target cell', () => {
    const { store } = rig();
    const changed = store.fillDown('dr', ['r1', 'r2', 'r3']);
    assert.deepEqual(changed, [{ rowKey: 'r3', colKey: 'dr' }], 'only the unlocked target changes');
    assert.equal(store.rowByKey.get('r2').row.dr, null, 'r2.dr stays blank (dc=C locks it)');
    assert.equal(store.rowByKey.get('r3').row.dr, '100');
});

await scenario('fillDown ignores an unknown target key', () => {
    const { store } = rig();
    const changed = store.fillDown('account', ['r1', 'ghost', 'r3']);
    assert.deepEqual(changed, [{ rowKey: 'r3', colKey: 'account' }]);
    assert.equal(store.rowByKey.get('r3').row.account, 'Cash');
});

if (failures.length > 0) {
    console.error(`\nclear vectors: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nclear vectors OK');
