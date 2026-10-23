/**
 * Node harness: pins the multi-row paste batch and the incremental row insert/remove path
 * against the REAL StateStore, Renderer (over the fake DOM), ClipboardManager, UndoManager and
 * SelectionPainter.
 *
 *   1. Pasting 200 new rows into an auto-append grid emits rows:changed ONCE, never rebuilds the
 *      body (the rows are inserted in place), and undoes as ONE step.
 *   2. A single insert/remove in the middle updates the DOM in place and restamps the rows after
 *      it (aria-rowindex, stripe, serial ordinal); the store's selection rectangle and the
 *      painted one stay on the rows the operator selected.
 *   3. The in-place path yields to a full rebuild when the body is virtual or has pad rows.
 *   4. UndoManager coalesces every record of one task (the whole paste) into one step.
 *
 * Invoke directly: `node tests/js/run-paste-batch.mjs` (also part of `npm test`).
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);
const { FakeElement, installFakeDom } = await import(pathToFileURL(resolve(here, 'support', 'fake-dom.mjs')).href);

installFakeDom();

const { default: EventBus } = await load('core/EventBus.js');
const { default: StateStore } = await load('core/StateStore.js');
const { default: Renderer } = await load('render/Renderer.js');
const { default: UndoManager } = await load('undo/UndoManager.js');
const { default: ClipboardManager } = await load('clipboard/ClipboardManager.js');
const { default: SelectionPainter } = await load('selection/SelectionPainter.js');

const settle = () => new Promise((r) => setTimeout(r, 0));

function rig({ rowCount = 5, layout = {} } = {}) {
    const bus = new EventBus();
    const store = new StateStore({
        name: 'pb',
        columns: [
            { key: '_serial', visible: true, navigable: false, painter: 'serial' },
            { key: 'name', visible: true, editable: true, writable: true, navigable: true, painter: 'text', parse: { kind: 'string' } },
            { key: 'qty', visible: true, editable: true, writable: true, navigable: true, painter: 'text', parse: { kind: 'int' } },
        ],
        rows: Array.from({ length: rowCount }, (_, i) => ({ _k: 'r' + i, name: 'N' + i, qty: i })),
        layout: { editable: true, autoAppend: true, striped: true, ...layout },
    }, bus);
    const refs = { root: new FakeElement(), scroll: new FakeElement(), head: new FakeElement(), body: new FakeElement(), footer: new FakeElement() };
    refs.scroll.clientHeight = 240;
    refs.scroll.scrollTop = 0;
    refs.head.offsetHeight = 24;
    const layoutStub = { refs, applyFrozenTo() {}, fillerCell: () => new FakeElement() };
    const renderer = new Renderer(store, layoutStub, refs, bus);
    let renders = 0;
    const render = renderer.body.render.bind(renderer.body);
    renderer.body.render = () => { renders += 1; render(); };
    renderer.renderBody();

    const events = { changed: [], inserted: [], removed: [] };
    bus.on('rows:changed', (p) => events.changed.push(p));
    bus.on('rows:inserted', (p) => events.inserted.push(p));
    bus.on('rows:removed', (p) => events.removed.push(p));

    const batches = [];
    const sync = { enqueueBatch: (items) => batches.push(items), enqueue(op) { batches.push([{ op }]); } };
    const undo = new UndoManager(store, sync, { announce: () => {} });
    store.recorder = undo;
    const clipboard = new ClipboardManager(store, { announce() {} });
    const ctx = {
        editor: {
            pasteCell(rowKey, colKey, column, raw) {
                const value = column.parse.kind === 'int' ? Number(raw) : raw;
                const cells = store.applyLocalSet(rowKey, colKey, value);
                return { ok: true, op: { seq: store.nextSeq(), t: 'set', row: rowKey, col: colKey, v: value }, cells };
            },
        },
        sync,
        popup: null,
    };
    const rowKeys = () => refs.body.children.map((c) => c.dataset.k);
    const serialOf = (key) => renderer.cellElFor(key, '_serial').textContent;
    return { bus, store, refs, renderer, renders: () => renders, events, batches, undo, clipboard, ctx, rowKeys, serialOf };
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

await scenario('a 200-row paste is one structural pass, no body rebuild, one undo step', async () => {
    const r = rig();
    assert.equal(r.renders(), 1, 'initial paint');
    r.store.setActive({ rowKey: 'r0', colKey: 'name' });
    const tsv = Array.from({ length: 205 }, (_, i) => `P${i}\t${1000 + i}`).join('\n');
    r.clipboard.paste(tsv, r.ctx);

    assert.equal(r.store.rowCount(), 205, '200 rows appended');
    assert.equal(r.events.changed.length, 1, 'rows:changed emitted once');
    assert.equal(r.events.changed[0].incremental, true);
    assert.deepEqual(r.events.inserted.map((e) => [e.index, e.keys.length]), [[5, 200]]);
    assert.equal(r.renders(), 1, 'the body was NOT rebuilt (at most once overall)');
    assert.equal(r.refs.body.children.length, 205, 'the 200 rows were inserted in place');
    assert.deepEqual(r.rowKeys().slice(0, 5), ['r0', 'r1', 'r2', 'r3', 'r4']);
    assert.deepEqual(r.rowKeys().slice(5), r.store.rows.slice(5).map((row) => row._k), 'DOM order = store order');
    assert.equal(r.renderer.body.rowElByKey.size, 205);
    assert.equal(r.renderer.body.cellElByKey.size, 205 * 3);
    assert.equal(r.renderer.body.windowEnd, 205);
    const last = r.store.rows[204];
    assert.equal(last.name, 'P204');
    assert.equal(last.qty, 1204);
    assert.equal(r.serialOf(last._k), '205');
    assert.equal(r.renderer.body.rowElByKey.get(last._k).getAttribute('aria-rowindex'), '206');
    assert.equal(r.store.rows[0].name, 'P0', 'existing rows overwritten too');
    assert.equal(r.batches.length, 1, 'one op batch');
    assert.equal(r.batches[0].filter((i) => i.op.t === 'insert').length, 200);
    assert.equal(r.batches[0].filter((i) => i.op.t === 'set').length, 410);

    // Values land through the cells:changed paint frame (the same frame every edit uses); the
    // inserted rows themselves were built blank, synchronously, by the insert.
    await settle();
    assert.equal(r.renderer.cellElFor(last._k, 'name').textContent, 'P204', 'pasted cells painted');
    assert.equal(r.renderer.cellElFor('r0', 'name').textContent, 'P0');
    assert.equal(r.renders(), 1);
    assert.equal(r.undo.undoStack.length, 1, 'the whole paste sealed into one undo step');
    assert.equal(r.undo.undo(), true);
    assert.equal(r.store.rowCount(), 5, 'one undo reverts all 200 rows');
    assert.equal(r.store.rows[0].name, 'N0', 'and the overwritten cells');
    assert.equal(r.refs.body.children.length, 5, 'rows removed from the DOM in place');
    assert.equal(r.renders(), 1, 'still no rebuild');
    assert.equal(r.renderer.body.rowElByKey.size, 5);
    assert.equal(r.renderer.body.cellElByKey.size, 15);
    assert.equal(r.undo.undoStack.length, 0);
    assert.equal(r.batches.length, 2, 'the undo flushed as one batch');
    assert.equal(r.batches[1].filter((i) => i.op.t === 'remove').length, 200);
    assert.equal(r.undo.redo(), true);
    assert.equal(r.store.rowCount(), 205, 'redo restores all 200 rows');
    assert.equal(r.refs.body.children.length, 205);
    assert.equal(r.renders(), 1);
});

await scenario('insert and remove in the middle update the DOM in place and restamp', () => {
    const r = rig();
    r.store.insertRow('mid', 'r1');
    assert.deepEqual(r.rowKeys(), ['r0', 'r1', 'mid', 'r2', 'r3', 'r4']);
    assert.equal(r.renders(), 1, 'no rebuild');
    assert.equal(r.serialOf('mid'), '3');
    assert.equal(r.serialOf('r2'), '4', 'rows after the insert are renumbered');
    assert.equal(r.serialOf('r4'), '6');
    assert.equal(r.renderer.body.rowElByKey.get('r2').getAttribute('aria-rowindex'), '5');
    assert.equal(r.renderer.body.rowElByKey.get('r2').classes.has('lgrid-row--stripe'), true, 'stripe parity follows the new index');
    assert.equal(r.renderer.body.rowElByKey.get('mid').classes.has('lgrid-row--stripe'), false);
    assert.deepEqual(r.events.removed, []);

    r.store.removeRow('mid');
    assert.deepEqual(r.rowKeys(), ['r0', 'r1', 'r2', 'r3', 'r4']);
    assert.equal(r.serialOf('r2'), '3');
    assert.equal(r.renderer.body.rowElByKey.get('r2').classes.has('lgrid-row--stripe'), false);
    assert.equal(r.renderer.cellElFor('mid', 'name'), null);
    assert.equal(r.renders(), 1);
    assert.deepEqual(r.events.removed.map((e) => [e.index, e.keys]), [[2, ['mid']]]);
    assert.equal(r.events.changed.length, 2);

    r.store.dupRow('r4', 'dup');
    assert.deepEqual(r.rowKeys(), ['r0', 'r1', 'r2', 'r3', 'r4', 'dup']);
    assert.equal(r.renderer.cellElFor('dup', 'name').textContent, 'N4');
    assert.equal(r.renders(), 1);
});

await scenario('the painted selection follows an in-place insert and remove', () => {
    const r = rig();
    const painter = new SelectionPainter(r.store, r.renderer, r.bus, { root: r.refs.root, scroll: r.refs.scroll });
    painter.scrollIntoView = () => {};
    r.store.setActive({ rowKey: 'r1', colKey: 'name' });
    r.store.setActive({ rowKey: 'r3', colKey: 'name' }, { keepAnchor: true, kind: 'range' });
    const selected = () => r.store.rows.filter((row) => r.renderer.cellElFor(row._k, 'name').classes.has('lgrid-cell--selected')).map((row) => row._k);
    assert.deepEqual(selected(), ['r1', 'r2', 'r3']);

    // The selection is anchored on r1 and ends on the active r3: a row inserted between them
    // joins the range (as a spreadsheet widens a range over an inserted row), and the active
    // ring stays the range's corner. The store's rect — what copy and Delete act on — moves
    // with the painted one.
    r.store.insertRow('mid', 'r1'); // lands at index 2, inside the rect 1..3
    assert.deepEqual(selected(), ['r1', 'mid', 'r2', 'r3'], 'the range widens over the inserted row');
    assert.deepEqual(painter.paintedRect, { r0: 1, r1: 4, c0: 1, c1: 1 });
    assert.deepEqual(r.store.selectedCellAddresses().map((a) => a.rowKey), ['r1', 'mid', 'r2', 'r3']);
    assert.equal(painter.activeEl, r.renderer.cellElFor('r3', 'name'), 'the active ring stays on its key');

    r.store.removeRow('r1'); // the rect's first row
    assert.deepEqual(selected(), ['mid', 'r2', 'r3'], 'the range shrinks by the removed row');
    assert.deepEqual(painter.paintedRect, { r0: 1, r1: 3, c0: 1, c1: 1 });
    r.store.removeRow('r0'); // above the rect: the selected rows move up, the highlight with them
    assert.deepEqual(selected(), ['mid', 'r2', 'r3']);
    assert.deepEqual(painter.paintedRect, { r0: 0, r1: 2, c0: 1, c1: 1 });
    assert.deepEqual(r.store.selectedCellAddresses().map((a) => a.rowKey), ['mid', 'r2', 'r3'], 'store rect = painted rect');

    r.store.insertRow('tail'); // appended below the rect: nothing moves
    assert.deepEqual(selected(), ['mid', 'r2', 'r3']);
    r.store.removeRow('mid');
    r.store.removeRow('r2');
    r.store.removeRow('r3');
    assert.equal(r.store.selection, null, 'every selected row removed → no rectangle');
    assert.deepEqual(selected(), []);
    painter.destroy();
});

await scenario('a whole-column selection grows over pasted rows', () => {
    const r = rig();
    const painter = new SelectionPainter(r.store, r.renderer, r.bus, { root: r.refs.root, scroll: r.refs.scroll });
    painter.scrollIntoView = () => {};
    r.store.setSelectionRect({ r0: 0, r1: 4, c0: 2, c1: 2 }, 'col', { rowKey: 'r3', colKey: 'qty' }, { rowKey: 'r0', colKey: 'qty' });
    r.clipboard.paste(['7', '8', '9'].join('\n'), r.ctx); // r3, r4 + one appended row
    assert.equal(r.store.rowCount(), 6);
    assert.deepEqual(r.store.selection, { r0: 0, r1: 5, c0: 2, c1: 2, kind: 'col' });
    const painted = r.store.rows.filter((row) => r.renderer.cellElFor(row._k, 'qty').classes.has('lgrid-cell--selected'));
    assert.equal(painted.length, 6, 'the appended row is painted too');
    painter.destroy();
});

await scenario('pad rows force the full rebuild, and the selection is repainted onto it', () => {
    const r = rig({ layout: { padRows: 10 } });
    const painter = new SelectionPainter(r.store, r.renderer, r.bus, { root: r.refs.root, scroll: r.refs.scroll });
    painter.scrollIntoView = () => {};
    r.store.setActive({ rowKey: 'r1', colKey: 'name' });
    r.store.setActive({ rowKey: 'r3', colKey: 'name' }, { keepAnchor: true, kind: 'range' });
    assert.equal(r.refs.body.children.length, 10, '5 rows + 5 pads');
    r.store.insertRow('n1');
    assert.equal(r.renders(), 2, 'rebuilt');
    assert.equal(r.renderer.bodyKept, false);
    assert.equal(r.refs.body.children.length, 10, '6 rows + 4 pads');
    assert.equal(r.events.changed.length, 1);
    const selected = r.store.rows.filter((row) => r.renderer.cellElFor(row._k, 'name').classes.has('lgrid-cell--selected')).map((row) => row._k);
    assert.deepEqual(selected, ['r1', 'r2', 'r3'], 'the rebuilt cells carry the selection again');
    assert.equal(r.renderer.cellElFor('r3', 'name').classes.has('lgrid-cell--active'), true);
    painter.destroy();
});

await scenario('a virtual body forces the full rebuild', () => {
    const r = rig({ rowCount: 2000 });
    assert.equal(r.renderer.body.virtual, true);
    const before = r.renderer.body.rowElByKey.size;
    r.store.insertRow('n1', 'r0');
    assert.equal(r.renders(), 2, 'rebuilt through the window path');
    assert.equal(r.renderer.body.rowElByKey.size, before);
    assert.ok(r.renderer.body.rowElByKey.has('n1'));
});

await scenario('crossing the virtual threshold on insert rebuilds into a window', () => {
    const r = rig({ rowCount: 750 });
    assert.equal(r.renderer.body.virtual, false);
    r.store.insertRow('n1');
    assert.equal(r.renders(), 2);
    assert.equal(r.renderer.body.virtual, true);
    assert.ok(r.renderer.body.rowElByKey.size < 100);
});

if (failures.length > 0) {
    console.error(`\npaste batch: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\npaste batch OK');
