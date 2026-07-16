/**
 * Node harness: exercises the REAL StateStore recorder seam + UndoManager replay engine —
 * batching (one task = one undo step), value/label/formula restoration, row insert/remove
 * round-trips with positioned wire ops, redo, redo invalidation and the reseed history wipe.
 * Exits non-zero with a diff on any mismatch. Invoked by tests/Feature/Grid/UndoVectorsTest.php
 * via Symfony Process (skipped when node is unavailable) and runnable directly:
 * `node tests/js/run-undo-vectors.mjs`.
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);

const { default: EventBus } = await load('core/EventBus.js');
const { default: StateStore } = await load('core/StateStore.js');
const { default: UndoManager } = await load('undo/UndoManager.js');

/** Wait past the microtask boundary so the open undo batch seals. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A fresh store + undo manager + op-collecting fake sync for each scenario. */
function rig({ rows, newRow } = {}) {
    const config = {
        name: 'g',
        columns: [
            { key: 'item', label: 'Item', editable: true, writable: true, navigable: true, parse: { kind: 'select' } },
            { key: 'qty', label: 'Qty', editable: true, writable: true, navigable: true, parse: { kind: 'int' } },
            { key: 'rate', label: 'Rate', editable: true, writable: true, navigable: true, parse: { kind: 'decimal' } },
            {
                key: 'amount', label: 'Amount', editable: false, writable: false, navigable: false,
                formula: { ast: { t: 'bin', op: '*', l: { t: 'col', k: 'qty' }, r: { t: 'col', k: 'rate' } } },
            },
        ],
        layout: { editable: true, ...(newRow ? { newRow } : {}) },
        rows: rows || [
            { _k: 'r1', item: 'i9', qty: 2, rate: '10', amount: 20, _labels: { item: 'Bolt' } },
            { _k: 'r2', item: null, qty: 5, rate: '4', amount: 20 },
        ],
    };
    const store = new StateStore(config, new EventBus());
    const flushed = [];
    const sync = { enqueueBatch: (items) => flushed.push(items.map((i) => i.op)) };
    const undo = new UndoManager(store, sync, { announce: () => {} });
    store.recorder = undo;
    return { store, undo, flushed };
}

const failures = [];
let current = '';
async function scenario(name, fn) {
    current = name;
    try {
        await fn();
        console.log(`  ok    ${name}`);
    } catch (e) {
        failures.push(`${name}: ${e.message}`);
        console.error(`  FAIL  ${name} — ${e.message}`);
    }
}

// Check the formula AST vocabulary against the real evaluator before relying on it: if the
// node tags drift, the rig rows would silently skip formula coverage.
await scenario('rig formula AST evaluates', async () => {
    const { store } = rig();
    store.applyLocalSet('r1', 'qty', 3);
    assert.equal(store.rowByKey.get('r1').row.amount, 30);
});

await scenario('a cell edit undoes and redoes through set ops', async () => {
    const { store, undo, flushed } = rig();
    store.applyLocalSet('r1', 'qty', 7);
    await settle();

    assert.equal(undo.undo(), true);
    assert.equal(store.rowByKey.get('r1').row.qty, 2, 'undo restores the before value');
    assert.equal(store.rowByKey.get('r1').row.amount, 20, 'undo re-derives the formula');
    const undoOps = flushed.pop();
    assert.equal(undoOps.length, 1);
    assert.deepEqual(
        { t: undoOps[0].t, row: undoOps[0].row, col: undoOps[0].col, v: undoOps[0].v },
        { t: 'set', row: 'r1', col: 'qty', v: 2 },
    );

    assert.equal(undo.redo(), true);
    assert.equal(store.rowByKey.get('r1').row.qty, 7, 'redo re-applies the after value');
    assert.equal(store.rowByKey.get('r1').row.amount, 70, 'redo re-derives the formula');
    const redoOps = flushed.pop();
    assert.equal(redoOps[0].v, 7);
});

await scenario('empty stacks refuse politely', async () => {
    const { undo, flushed } = rig();
    assert.equal(undo.undo(), false);
    assert.equal(undo.redo(), false);
    assert.equal(flushed.length, 0, 'no ops ride an empty undo');
});

await scenario('mutations in one task coalesce into one undo step', async () => {
    const { store, undo } = rig();
    store.applyLocalSet('r1', 'qty', 9);   // a commit plus its whenFilled sibling mirror
    store.applyLocalSet('r1', 'rate', '3');
    await settle();
    store.applyLocalSet('r2', 'qty', 1);   // a separate later edit
    await settle();

    undo.undo();
    assert.equal(store.rowByKey.get('r2').row.qty, 5, 'last step undone first');
    assert.equal(store.rowByKey.get('r1').row.qty, 9, 'earlier step untouched');

    undo.undo();
    assert.equal(store.rowByKey.get('r1').row.qty, 2, 'both cells of the grouped step revert');
    assert.equal(store.rowByKey.get('r1').row.rate, '10');
});

await scenario('a new edit invalidates the redo stack', async () => {
    const { store, undo } = rig();
    store.applyLocalSet('r1', 'qty', 7);
    await settle();
    undo.undo();
    assert.equal(undo.canRedo(), true);

    store.applyLocalSet('r1', 'qty', 4);
    await settle();
    assert.equal(undo.canRedo(), false, 'redo history dies with the new edit');
    assert.equal(undo.redo(), false);
});

await scenario('undoing an insert removes the row with a remove op', async () => {
    const { store, undo, flushed } = rig();
    store.insertRow('r3', 'r1');
    await settle();
    assert.equal(store.rowCount(), 3);

    undo.undo();
    assert.equal(store.rowCount(), 2, 'the inserted row is gone');
    assert.equal(store.rowByKey.has('r3'), false);
    const ops = flushed.pop();
    assert.deepEqual({ t: ops[0].t, row: ops[0].row }, { t: 'remove', row: 'r3' });

    undo.redo();
    assert.equal(store.rowIndexOf('r3'), 1, 'redo restores the row at its index');
});

await scenario('undoing a remove restores the row, its position and its data', async () => {
    const { store, undo, flushed } = rig();
    store.removeRow('r1'); // the FIRST row — `after` alone cannot express this position
    await settle();
    assert.equal(store.rowCount(), 1);

    undo.undo();
    assert.equal(store.rowIndexOf('r1'), 0, 'restored at its original index');
    const row = store.rowByKey.get('r1').row;
    assert.equal(row.qty, 2);
    assert.equal(row.rate, '10');
    assert.deepEqual(row._labels, { item: 'Bolt' }, 'picker labels restored');

    const ops = flushed.pop();
    assert.deepEqual(
        { t: ops[0].t, as: ops[0].as, before: ops[0].before },
        { t: 'insert', as: 'r1', before: 'r2' },
        'the insert op is positioned BEFORE the row that had taken its place',
    );
    const sets = ops.slice(1);
    assert.deepEqual(
        sets.map((op) => [op.col, op.v]),
        [['item', 'i9'], ['qty', 2], ['rate', '10']],
        'one set per writable snapshot value (never the formula column)',
    );
    assert.equal(sets[0].label, 'Bolt', 'the picker set carries its label');

    undo.redo();
    assert.equal(store.rowByKey.has('r1'), false, 'redo removes it again');
    assert.deepEqual(flushed.pop().map((op) => op.t), ['remove']);
});

await scenario('a blank snapshot cell with a template default converges via a null set', async () => {
    const { store, undo, flushed } = rig({
        rows: [{ _k: 'r1', item: null, qty: null, rate: null, amount: 0 }],
        newRow: { qty: 1 },
    });
    store.removeRow('r1');
    await settle();
    undo.undo();

    const ops = flushed.pop();
    const qtySet = ops.find((op) => op.t === 'set' && op.col === 'qty');
    assert.ok(qtySet, 'the template-defaulted column gets an explicit null set');
    assert.equal(qtySet.v, null);
    assert.equal(ops.filter((op) => op.t === 'set').length, 1, 'blank templateless columns send nothing');
});

await scenario('label edits undo with their set op', async () => {
    const { store, undo, flushed } = rig();
    // A picker commit: value + label in one task (commitCell order).
    store.applyLocalSet('r1', 'item', 'i2');
    store.setRowLabel('r1', 'item', 'Nut');
    await settle();

    undo.undo();
    const row = store.rowByKey.get('r1').row;
    assert.equal(row.item, 'i9');
    assert.deepEqual(row._labels, { item: 'Bolt' }, 'the before label is restored');
    const ops = flushed.pop();
    assert.equal(ops[0].label, 'Bolt', 'the undo set op carries the before label');

    undo.redo();
    assert.deepEqual(store.rowByKey.get('r1').row._labels, { item: 'Nut' });
    assert.equal(flushed.pop()[0].label, 'Nut');
});

await scenario('a reseed wipes the history', async () => {
    const { store, undo } = rig();
    store.applyLocalSet('r1', 'qty', 7);
    await settle();
    store.reseed([{ _k: 'n1', item: null, qty: 0, rate: '0', amount: 0 }]);
    assert.equal(undo.canUndo(), false);
    assert.equal(undo.undo(), false);
});

await scenario('replayed mutations never re-record', async () => {
    const { store, undo } = rig();
    store.applyLocalSet('r1', 'qty', 7);
    await settle();
    undo.undo();
    await settle();
    assert.equal(undo.undoStack.length, 0, 'the undo replay did not create a new step');
    undo.redo();
    await settle();
    assert.equal(undo.undoStack.length, 1, 'redo moved the step back, nothing more');
    assert.equal(undo.redoStack.length, 0);
});

await scenario('history is capped', async () => {
    const { store, undo } = rig();
    undo.limit = 3;
    for (let i = 0; i < 5; i++) {
        store.applyLocalSet('r1', 'qty', 100 + i);
        await settle();
    }
    assert.equal(undo.undoStack.length, 3, 'oldest steps fall off past the cap');
});

if (failures.length > 0) {
    console.error(`\nundo vectors: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nundo vectors OK');
