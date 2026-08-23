import assert from 'node:assert/strict';
import EventBus from '../../resources/js/core/EventBus.js';
import StateStore from '../../resources/js/core/StateStore.js';
import SyncManager from '../../resources/js/sync/SyncManager.js';

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

console.log('sync vectors: ok');
