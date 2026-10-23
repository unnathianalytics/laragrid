import assert from 'node:assert/strict';
import EventBus from '../../resources/js/core/EventBus.js';
import StateStore from '../../resources/js/core/StateStore.js';
import SyncManager from '../../resources/js/sync/SyncManager.js';
import { cellMapKey } from '../../resources/js/util/dom.js';

function makeStore(sync = 'per-cell') {
    const bus = new EventBus();
    const store = new StateStore({
        name: 'lines',
        columns: [{ key: 'name', label: 'Name', editable: true, visible: true }],
        rows: [{ _k: 'r1', name: 'old' }],
        layout: { editable: true, sync },
    }, bus);
    return { bus, store };
}

function result(seq, overrides = {}) {
    return {
        version: seq,
        footer: {},
        results: [{ seq, ok: true, patch: [], errors: [], ...overrides }],
    };
}

// A failure must be owned by one delayed timer; finally must not immediately recurse.
{
    const { bus, store } = makeStore();
    const timers = [];
    let calls = 0;
    const sync = new SyncManager(store, bus, {
        gridOps: async () => {
            calls += 1;
            throw new Error('network');
        },
    }, {
        random: () => 0.5,
        setTimer: (fn, delay) => {
            timers.push({ fn, delay });
            return timers.length;
        },
        clearTimer: () => {},
    });
    const cells = store.applyLocalSet('r1', 'name', 'new');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'new' }, cells);
    await sync.flushPromise;
    assert.equal(calls, 1);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 300);
    assert.equal(sync.status, 'retrying');
    for (let index = 0; index < timers.length; index++) {
        timers[index].fn();
        await sync.flushPromise;
    }
    assert.equal(calls, 6, 'initial call plus five bounded retries');
    assert.equal(sync.status, 'failed');
    assert.equal(sync.retryTimer, null);
    sync.destroy();
}

// A normal successful SET has an empty patch but must still settle its submitted cell.
{
    const { bus, store } = makeStore();
    const sync = new SyncManager(store, bus, {
        gridOps: async (_name, batch) => result(batch.ops[0].seq),
    });
    const cells = store.applyLocalSet('r1', 'name', 'new');
    const seq = store.nextSeq();
    sync.enqueue({ seq, t: 'set', row: 'r1', col: 'name', v: 'new' }, cells);
    await sync.whenSettled();
    assert.equal(store.pending.size, 0);
    assert.equal(store.dirty.size, 0);
    assert.equal(store.errors.size, 0);
    assert.equal(store.modified.size, 1, 'acknowledgement is not a durable host save');
    sync.destroy();
}

// Session/authorization failures are terminal and never enter the retry loop.
{
    const { bus, store } = makeStore();
    const timers = [];
    const error = new Error('Page expired');
    error.status = 419;
    const sync = new SyncManager(store, bus, { gridOps: async () => { throw error; } }, {
        setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    });
    const cells = store.applyLocalSet('r1', 'name', 'new');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'new' }, cells);
    await sync.flushPromise;
    assert.equal(sync.status, 'failed');
    assert.equal(sync.queue.length, 1);
    assert.equal(timers.length, 0);
    sync.destroy();
}

// Offline mode makes no request and rejects a save wait immediately while retaining the queue.
{
    const { bus, store } = makeStore();
    let calls = 0;
    const sync = new SyncManager(store, bus, {
        gridOps: async () => { calls += 1; return result(1); },
    }, { isOnline: () => false });
    const cells = store.applyLocalSet('r1', 'name', 'new');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'new' }, cells);
    await assert.rejects(() => sync.whenSettled(), /offline/i);
    assert.equal(calls, 0);
    assert.equal(sync.queue.length, 1);
    sync.destroy();
}

// A failed validation settles pending; the next successful correction clears the old message.
{
    const { bus, store } = makeStore();
    let call = 0;
    const sync = new SyncManager(store, bus, {
        gridOps: async (_name, batch) => {
            call += 1;
            const seq = batch.ops[0].seq;
            return call === 1
                ? result(seq, {
                    ok: false,
                    errors: { r1: { name: 'Name is invalid.' } },
                })
                : result(seq);
        },
    });
    let cells = store.applyLocalSet('r1', 'name', 'bad');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'bad' }, cells);
    await sync.flushPromise;
    assert.equal(store.pending.size, 0);
    assert.equal(store.errorFor('r1', 'name'), 'Name is invalid.');

    cells = store.applyLocalSet('r1', 'name', 'good');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'good' }, cells);
    await sync.whenSettled();
    assert.equal(store.errorFor('r1', 'name'), null);
    assert.equal(store.dirty.size, 0);
    sync.destroy();
}

// Response N cannot overwrite optimistic edit N+1 while N+1 waits in the queue.
{
    const { bus, store } = makeStore();
    const resolvers = [];
    const sync = new SyncManager(store, bus, {
        gridOps: (_name, batch) => new Promise((resolve) => resolvers.push({ resolve, batch })),
    });
    let cells = store.applyLocalSet('r1', 'name', 'first');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'first' }, cells);
    cells = store.applyLocalSet('r1', 'name', 'second');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'second' }, cells);

    resolvers[0].resolve(result(1, { patch: { r1: { name: 'first-server' } } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(store.rowByKey.get('r1').row.name, 'second');
    resolvers[1].resolve(result(2));
    await sync.whenSettled();
    assert.equal(store.rowByKey.get('r1').row.name, 'second');
    sync.destroy();
}

// Per-row batches locally until GridCore reports that the active row was left.
{
    const { bus, store } = makeStore('per-row');
    let calls = 0;
    const sync = new SyncManager(store, bus, {
        gridOps: async (_name, batch) => {
            calls += 1;
            return result(batch.ops[0].seq);
        },
    });
    const cells = store.applyLocalSet('r1', 'name', 'new');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'new' }, cells);
    await Promise.resolve();
    assert.equal(calls, 0);
    sync.onActiveRowChanged();
    await sync.whenSettled();
    assert.equal(calls, 1);
    sync.destroy();
}

// A stale base-version conflict is terminal (no loop), preserves the op, adopts the current
// server revision, and succeeds only after the operator explicitly retries.
{
    const { bus, store } = makeStore();
    let calls = 0;
    const sync = new SyncManager(store, bus, {
        gridOps: async (_name, batch) => {
            calls += 1;
            const seq = batch.ops[0].seq;
            return calls === 1
                ? result(seq, { conflict: true, ok: false })
                : { ...result(seq), version: 6 };
        },
    });
    const cells = store.applyLocalSet('r1', 'name', 'mine');
    sync.enqueue({ seq: store.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'mine' }, cells);
    await sync.flushPromise;
    assert.equal(sync.status, 'failed');
    assert.equal(sync.queue.length, 1);
    assert.equal(store.version, 1);
    await sync.retryNow();
    await sync.whenSettled();
    assert.equal(calls, 2);
    assert.equal(store.dirty.size, 0);
    sync.destroy();
}

// A batch marks its cells pending in one pass: one sync-state carrying every cell and one
// edit-state, then the queue's own state and the flush start (3 sync-state emits for a
// 100-cell batch, not 102).
{
    const { bus, store } = makeStore();
    store.setRows(Array.from({ length: 100 }, (_, i) => ({ _k: 'b' + i, name: '' })));
    const sync = new SyncManager(store, bus, { gridOps: () => new Promise(() => {}) });
    const items = store.rows.map((row) => ({
        op: { seq: store.nextSeq(), t: 'set', row: row._k, col: 'name', v: 'x' },
        cells: store.applyLocalSet(row._k, 'name', 'x'),
    }));
    const syncStates = [];
    let editStates = 0;
    bus.on('sync-state', (state) => syncStates.push(state));
    bus.on('edit-state', () => { editStates += 1; });
    sync.enqueueBatch(items);
    assert.equal(syncStates.length, 3, 'markPendingBatch + queue state + flush start');
    assert.equal(syncStates[0].cells.length, 100, 'the pending emit carries every cell');
    assert.equal(editStates, 1);
    assert.equal(store.pending.size, 100);
    assert.equal(store.pendingSeqs.get(cellMapKey('b99', 'name')).has(items[99].op.seq), true);
    assert.equal(sync.status, 'syncing');
    sync.destroy();
}

// GridCore publishes the sync state once per task with the final state: a 100-cell paste
// (30 existing rows + 20 appended, two columns) dispatches lgrid:statechange once, and the
// acknowledgement once more.
{
    const { FakeElement, installFakeDom } = await import('./support/fake-dom.mjs');
    const dom = installFakeDom();
    const { default: GridCore } = await import('../../resources/js/core/GridCore.js');
    const { default: ClipboardManager } = await import('../../resources/js/clipboard/ClipboardManager.js');
    const root = new FakeElement();
    const dispatched = [];
    root.dispatchEvent = (event) => {
        dispatched.push({ type: event.type, ...event.detail });
        return true;
    };
    let acknowledge;
    const wire = {
        gridOps: (_name, batch) => new Promise((resolve) => {
            acknowledge = () => resolve({
                version: 1,
                footer: {},
                results: batch.ops.map((op) => ({ seq: op.seq, ok: true, patch: [], errors: [] })),
            });
        }),
    };
    const core = new GridCore({
        name: 'lines',
        columns: [
            { key: 'name', label: 'Name', visible: true, editable: true, navigable: true, parse: { kind: 'string' } },
            { key: 'qty', label: 'Qty', visible: true, editable: true, navigable: true, parse: { kind: 'int' } },
        ],
        rows: Array.from({ length: 30 }, (_, i) => ({ _k: 'r' + i, name: '', qty: 0 })),
        layout: { editable: true, autoAppend: true },
    }, {
        root,
        body: new FakeElement(),
        wire,
        editor: Object.assign(new FakeElement(), { querySelector: () => null }),
        syncStatus: new FakeElement(),
    });
    // installEditing() runs after init() has built these; stand-ins are enough here.
    core.renderer = { cellElFor: () => null, repaintCell: () => null, footer: { render() {} }, destroy() {} };
    core.clipboard = new ClipboardManager(core.store, {});
    core.installEditing();
    await Promise.resolve();
    assert.equal(dispatched.length, 1, 'the install publishes the initial state once');
    assert.equal(dispatched[0].type, 'lgrid:statechange');

    core.store.setActive({ rowKey: 'r0', colKey: 'name' });
    const tsv = Array.from({ length: 50 }, (_, i) => `N${i}\t${i}`).join('\n');
    core.clipboard.paste(tsv, { editor: core.editorManager, sync: core.sync, popup: null });
    assert.equal(core.store.rowCount(), 50);
    assert.equal(core.store.pending.size, 100);
    assert.equal(dispatched.length, 1, 'nothing is dispatched inside the paste task');
    await Promise.resolve();
    assert.equal(dispatched.length, 2, 'the 100-cell paste dispatches lgrid:statechange once');
    assert.equal(dispatched[1].status, 'syncing');
    assert.equal(dispatched[1].pending, 100);
    assert.equal(core.refs.syncStatus.textContent, 'Syncing 100…');

    acknowledge();
    await core.sync.whenSettled();
    await Promise.resolve();
    assert.equal(dispatched.length, 3, 'the acknowledgement dispatches once more');
    assert.equal(dispatched[2].status, 'idle');
    assert.equal(dispatched[2].pending, 0);
    assert.equal(dispatched[2].modified, 101, '100 cells + the structural flag for the appended rows');
    assert.equal(core.refs.syncStatus.textContent, 'Changes ready to save');

    core.destroy();
    dom.restore();
}

console.log('sync vectors: ok');
