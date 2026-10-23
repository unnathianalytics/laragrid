/**
 * Node harness: pins the DraftStore's storage traffic against the REAL StateStore, SyncManager
 * and DraftStore over a counting in-memory backend.
 *
 *   1. Cursor movement never saves: 50 moves on a clean grid make zero storage calls, and a
 *      clean grid that already holds no draft skips the remove round trip.
 *   2. One edit followed by 50 moves writes once, and the draft restored from that write puts
 *      the operator back on the last active cell.
 *   3. A save raised only by sync-state / errors:changed reuses the serialized rows; an edit
 *      (or a row insert) serializes them again.
 *   4. Clean again after a save: one remove, then silence.
 *
 * Invoke directly: `node tests/js/run-draft-store.mjs` (also part of `npm test`).
 */
import { strict as assert } from 'node:assert';
import EventBus from '../../resources/js/core/EventBus.js';
import StateStore from '../../resources/js/core/StateStore.js';
import SyncManager from '../../resources/js/sync/SyncManager.js';
import DraftStore from '../../resources/js/persist/DraftStore.js';

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function makeTarget(extra = {}) {
    return {
        hidden: true,
        textContent: '',
        addEventListener() {},
        removeEventListener() {},
        ...extra,
    };
}

function makeBackend() {
    const records = new Map();
    const calls = { get: 0, put: 0, delete: 0 };
    const puts = [];
    return {
        records,
        calls,
        puts,
        total: () => calls.get + calls.put + calls.delete,
        async get(key) { calls.get += 1; return records.get(key) || null; },
        async put(key, value) { calls.put += 1; puts.push(value); records.set(key, value); },
        async delete(key) { calls.delete += 1; records.delete(key); },
    };
}

async function rig(backend, wire = { gridOps: async () => ({}) }) {
    const bus = new EventBus();
    const store = new StateStore({
        name: 'lines',
        columns: [
            { key: 'name', label: 'Name', editable: true, visible: true },
            { key: 'qty', label: 'Qty', editable: true, visible: true },
        ],
        rows: Array.from({ length: 4 }, (_, i) => ({ _k: 'r' + i, name: 'N' + i, qty: i })),
        layout: { editable: true, sync: 'deferred' },
    }, bus);
    const sync = new SyncManager(store, bus, wire);
    const refs = {
        draftBar: makeTarget(),
        draftMessage: makeTarget(),
        draftRestore: makeTarget(),
        draftDiscard: makeTarget(),
    };
    const draft = new DraftStore({ mode: 'local', key: 'tenant:lines' }, store, sync, bus, refs, { backend, debounceMs: 1 });
    await draft.init();
    const edit = (rowKey, colKey, value) => {
        const cells = store.applyLocalSet(rowKey, colKey, value);
        sync.enqueue({ seq: store.nextSeq(), t: 'set', row: rowKey, col: colKey, v: value }, cells);
    };
    const moves = (count) => {
        for (let i = 0; i < count; i++) {
            store.setActive({ rowKey: 'r' + (i % 4), colKey: i % 2 ? 'qty' : 'name' });
        }
        return { rowKey: 'r' + ((count - 1) % 4), colKey: (count - 1) % 2 ? 'qty' : 'name' };
    };
    const destroy = () => {
        draft.destroy();
        sync.destroy();
    };
    return { bus, store, sync, draft, refs, edit, moves, destroy };
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

await scenario('50 cursor moves on a clean grid make zero storage calls', async () => {
    const backend = makeBackend();
    const r = await rig(backend);
    const afterInit = backend.total();
    r.moves(50);
    await wait();
    assert.equal(backend.total(), afterInit, 'no read, write or remove');
    // Non-row triggers on a clean grid with nothing stored skip the remove round trip too.
    r.bus.emit('errors:changed', { errors: r.store.errors, keys: [] });
    r.bus.emit('sync-state', { pending: 0 });
    await wait();
    assert.equal(backend.total(), afterInit);
    r.destroy();
});

await scenario('one edit then 50 moves writes once; the restored draft carries the last active cell', async () => {
    const backend = makeBackend();
    const r = await rig(backend);
    r.edit('r1', 'name', 'edited');
    const last = r.moves(50);
    await wait();
    assert.equal(backend.calls.put, 1, 'one write');
    assert.equal(backend.calls.delete, 0);
    assert.deepEqual(backend.puts[0].active, last, 'the write saw the last active cell');

    // Later movement alone still writes nothing; pagehide writes the cursor where it stands.
    const later = r.moves(7);
    await wait();
    assert.equal(backend.calls.put, 1, 'moves after the write do not save');
    await r.draft.onPageHide();
    assert.equal(backend.calls.put, 2);
    assert.deepEqual(backend.puts[1].active, later);
    r.destroy();

    const wire = {
        gridOps: async (_name, batch) => ({
            version: 1,
            footer: {},
            results: batch.ops.map((op) => ({ seq: op.seq, ok: true, patch: [], errors: [] })),
        }),
        gridRestoreDraft: async (_name, payload) => ({ version: 1, footer: {}, results: [], rows: payload.rows }),
    };
    const next = await rig(backend, wire);
    assert.equal(next.refs.draftBar.hidden, false, 'the candidate is offered');
    assert.equal(await next.draft.restoreCandidate(), true);
    await next.sync.whenSettled();
    assert.equal(next.store.rowByKey.get('r1').row.name, 'edited');
    assert.deepEqual(next.store.active, later, 'restored onto the last active cell');
    next.destroy();
});

await scenario('sync-state and errors:changed saves reuse the serialized rows; an edit does not', async () => {
    const backend = makeBackend();
    const r = await rig(backend);
    r.edit('r0', 'qty', 7);
    await wait();
    assert.equal(backend.calls.put, 1);
    const firstRows = backend.puts[0].rows;

    r.bus.emit('sync-state', { pending: 1 });
    await wait();
    r.store.setError('r2', 'qty', 'Too large');
    // setError also emits edit-state (the error count) — the rows are serialized again.
    await wait();
    assert.equal(backend.calls.put, 3);
    assert.equal(backend.puts[1].rows, firstRows, 'sync-state alone reused the cached rows');
    assert.notEqual(backend.puts[2].rows, firstRows, 'edit-state drops the cache');
    const errorRows = backend.puts[2].rows;

    r.bus.emit('errors:changed', { errors: r.store.errors, keys: [] });
    await wait();
    assert.equal(backend.calls.put, 4);
    assert.equal(backend.puts[3].rows, errorRows, 'errors:changed alone reused the cached rows');
    assert.deepEqual(backend.puts[3].errors, [[r.store.errorKey('r2', 'qty'), 'Too large']]);

    r.edit('r3', 'name', 'fresh');
    await wait();
    assert.notEqual(backend.puts[4].rows, errorRows);
    assert.equal(backend.puts[4].rows.find((row) => row._k === 'r3').name, 'fresh');

    // A label write emits only cells:changed; the next save must still carry it.
    r.store.setRowLabel('r3', 'name', 'Fresh label');
    r.bus.emit('sync-state', { pending: 2 });
    await wait();
    assert.equal(backend.puts[5].rows.find((row) => row._k === 'r3')._labels.name, 'Fresh label');

    r.store.insertRow('n1', 'r0');
    await wait();
    const inserted = backend.puts[backend.puts.length - 1].rows;
    assert.deepEqual(inserted.map((row) => row._k), ['r0', 'n1', 'r1', 'r2', 'r3']);
    r.destroy();
});

await scenario('clean after a save: one remove, then no storage calls', async () => {
    const backend = makeBackend();
    const r = await rig(backend, {
        gridOps: async (_name, batch) => ({
            version: 1,
            footer: {},
            results: batch.ops.map((op) => ({ seq: op.seq, ok: true, patch: [], errors: [] })),
        }),
    });
    r.edit('r0', 'name', 'x');
    await wait();
    assert.equal(backend.calls.put, 1);
    await r.sync.flush();
    await r.sync.whenSettled();
    r.store.markSaved();
    await wait();
    const settled = backend.total();
    assert.equal(backend.calls.delete, 1, 'the draft is removed once the grid is clean');
    assert.equal(backend.records.size, 0);

    r.moves(50);
    r.bus.emit('sync-state', { pending: 0 });
    r.store.emitEditState();
    await wait();
    assert.equal(backend.total(), settled, 'clean and already removed: nothing more');
    r.destroy();
});

if (failures.length > 0) {
    console.error(`\ndraft store: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\ndraft store OK');
