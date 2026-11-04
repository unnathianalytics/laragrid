/**
 * Node harness: pins row move (plan F4) on the REAL StateStore, Renderer, SelectionPainter,
 * UndoManager and RowDragger over the fake DOM.
 *
 *   1. moveRow reindexes, keeps the active cell on its row, collapses a range selection, and
 *      emits rows:moved then an incremental rows:changed; a move onto its own index is a no-op.
 *   2. The body moves the row element in place (no rebuild), keeps rowElByKey / cellElByKey
 *      sized, and restamps serial text, aria-rowindex and stripes; the painted selection is
 *      cleared where the rows went.
 *   3. A virtual body declines the in-place move and rebuilds.
 *   4. moveOpFor anchors on the next row, else the previous one.
 *   5. Undo restores the order and stages a `move` op with the right anchor; redo re-moves; a
 *      move of a row a later undone step removed is skipped.
 *   6. Alt+ArrowUp / Alt+ArrowDown are row-op chords; RowDragger's drop math and a simulated
 *      gutter drag land the row where the insertion line showed, and Escape cancels.
 *
 * Invoke directly: `node tests/js/run-row-move.mjs` (also part of `npm test`).
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
const { default: SelectionPainter } = await load('selection/SelectionPainter.js');
const { default: UndoManager } = await load('undo/UndoManager.js');
const { default: RowDragger } = await load('interact/RowDragger.js');
const { SHARED_KEYMAP } = await load('keyboard/keys.js');

const settle = () => new Promise((r) => setTimeout(r, 0));

function rig({ rowCount = 5, layout = {} } = {}) {
    const bus = new EventBus();
    const store = new StateStore({
        name: 'mv',
        columns: [
            { key: '_serial', visible: true, navigable: false, painter: 'serial' },
            { key: 'name', visible: true, editable: true, writable: true, navigable: true, painter: 'text' },
            { key: 'qty', visible: true, editable: true, writable: true, navigable: true, painter: 'text' },
        ],
        rows: Array.from({ length: rowCount }, (_, i) => ({ _k: 'r' + i, name: 'N' + i, qty: i })),
        layout: { editable: true, striped: true, ...layout },
    }, bus);
    const refs = { root: new FakeElement(), scroll: new FakeElement(), head: new FakeElement(), body: new FakeElement(), footer: new FakeElement() };
    refs.scroll.clientHeight = 240;
    refs.head.offsetHeight = 24;
    const renderer = new Renderer(store, { refs, applyFrozenTo() {}, fillerCell: () => new FakeElement(), columnWidth: () => 100 }, refs, bus);
    let renders = 0;
    const render = renderer.body.render.bind(renderer.body);
    renderer.body.render = () => { renders += 1; render(); };
    renderer.renderBody();
    const painter = new SelectionPainter(store, renderer, bus, { root: refs.root, scroll: refs.scroll });

    const events = [];
    bus.on('rows:moved', (p) => events.push(['moved', p]));
    bus.on('rows:changed', (p) => events.push(['changed', p]));

    const batches = [];
    const sync = { enqueueBatch: (items) => batches.push(items), enqueue(op) { batches.push([{ op }]); } };
    const undo = new UndoManager(store, sync, { announce() {} });
    store.recorder = undo;

    const keys = () => store.rows.map((row) => row._k);
    const domKeys = () => refs.body.children.map((c) => c.dataset.k);
    const serial = (key) => renderer.cellElFor(key, '_serial').textContent;
    return { bus, store, refs, renderer, painter, renders: () => renders, events, batches, undo, keys, domKeys, serial };
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

await scenario('moveRow reindexes, keeps the active key, collapses a range, emits moved then changed', () => {
    const r = rig();
    r.store.setActive({ rowKey: 'r1', colKey: 'name' });
    r.store.setActive({ rowKey: 'r3', colKey: 'qty' }, { keepAnchor: true, kind: 'range' });
    r.store.setActive({ rowKey: 'r1', colKey: 'name' }, { keepAnchor: true, kind: 'range' });
    r.store.setActive({ rowKey: 'r3', colKey: 'qty' }, { keepAnchor: true, kind: 'range' });
    assert.deepEqual([r.store.selection.r0, r.store.selection.r1], [1, 3]);

    assert.equal(r.store.moveRow('r3', 0), true);
    assert.deepEqual(r.keys(), ['r3', 'r0', 'r1', 'r2', 'r4']);
    assert.equal(r.store.rowIndexOf('r3'), 0);
    assert.equal(r.store.rowByKey.get('r2').index, 3);
    assert.deepEqual(r.store.active, { rowKey: 'r3', colKey: 'qty' }, 'the active cell follows its row');
    assert.deepEqual(r.store.selection, { r0: 0, r1: 0, c0: 2, c1: 2, kind: 'cell' }, 'the range collapsed');
    assert.deepEqual(r.events.map(([name]) => name), ['moved', 'changed']);
    assert.deepEqual(r.events[0][1], { key: 'r3', from: 3, to: 0 });
    assert.equal(r.events[1][1].incremental, true);
    assert.equal(r.store.structureModified, true);

    r.events.length = 0;
    assert.equal(r.store.moveRow('r3', 0), false, 'onto its own index');
    assert.equal(r.store.moveRow('ghost', 1), false);
    assert.equal(r.events.length, 0);
});

await scenario('the body moves the row element in place and restamps', () => {
    const r = rig();
    r.store.setActive({ rowKey: 'r0', colKey: 'name' });
    r.store.setActive({ rowKey: 'r1', colKey: 'qty' }, { keepAnchor: true, kind: 'range' });
    const painted = () => r.refs.body.children.flatMap((row) => row.children).filter((cell) => cell.classes && cell.classes.has('lgrid-cell--selected')).length;
    assert.equal(painted(), 4, 'a 2 x 2 range is painted');
    const moved = r.renderer.body.rowElByKey.get('r0');

    r.store.moveRow('r0', 3);
    assert.equal(r.renders(), 1, 'no body rebuild');
    assert.deepEqual(r.domKeys(), ['r1', 'r2', 'r3', 'r0', 'r4']);
    assert.equal(r.renderer.body.rowElByKey.get('r0'), moved, 'the same element moved');
    assert.equal(r.renderer.body.rowElByKey.size, 5);
    assert.equal(r.renderer.body.cellElByKey.size, 15);
    assert.deepEqual(['r1', 'r2', 'r3', 'r0', 'r4'].map(r.serial), ['1', '2', '3', '4', '5']);
    assert.equal(moved.getAttribute('aria-rowindex'), '5');
    assert.equal(moved.classes.has('lgrid-row--stripe'), true, 'index 3 is a stripe row');
    assert.equal(r.renderer.body.rowElByKey.get('r1').classes.has('lgrid-row--stripe'), false);
    assert.equal(painted(), 0, 'the scattered range is cleared');
});

await scenario('a virtual body declines the in-place move and rebuilds', () => {
    const r = rig({ rowCount: 400, layout: { virtualizeRowsAbove: 100 } });
    if (!r.renderer.body.virtual) {
        r.renderer.body.virtual = true; // the threshold key differs per build: force the mode
    }
    const before = r.renders();
    r.store.moveRow('r5', 0);
    assert.equal(r.renders(), before + 1, 'the body rebuilt');
    assert.equal(r.store.rowIndexOf('r5'), 0);
});

await scenario('moveOpFor anchors on the next row, else the previous one', () => {
    const r = rig({ rowCount: 3 });
    r.store.moveRow('r2', 0);
    assert.deepEqual({ ...r.store.moveOpFor('r2'), seq: 0 }, { seq: 0, t: 'move', row: 'r2', before: 'r0' });
    r.store.moveRow('r2', 2);
    assert.deepEqual({ ...r.store.moveOpFor('r2'), seq: 0 }, { seq: 0, t: 'move', row: 'r2', after: 'r1' });
    const single = rig({ rowCount: 1 });
    assert.deepEqual({ ...single.store.moveOpFor('r0'), seq: 0 }, { seq: 0, t: 'move', row: 'r0' });
});

await scenario('undo restores the order with a move op; redo re-moves; a removed row is skipped', async () => {
    const r = rig();
    r.store.setActive({ rowKey: 'r1', colKey: 'name' });
    r.store.moveRow('r1', 3);
    await settle();

    r.undo.undo();
    assert.deepEqual(r.keys(), ['r0', 'r1', 'r2', 'r3', 'r4']);
    let ops = r.batches.at(-1).map((item) => item.op);
    assert.deepEqual(ops.map(({ t, row, before, after }) => ({ t, row, before, after })), [{ t: 'move', row: 'r1', before: 'r2', after: undefined }]);

    r.undo.redo();
    assert.deepEqual(r.keys(), ['r0', 'r2', 'r3', 'r1', 'r4']);
    ops = r.batches.at(-1).map((item) => item.op);
    assert.deepEqual(ops.map(({ t, row, before }) => ({ t, row, before })), [{ t: 'move', row: 'r1', before: 'r4' }]);

    // Move then remove r4; undoing both restores it at its moved index, then moves it back.
    r.store.moveRow('r4', 0);
    await settle();
    r.store.removeRow('r4');
    await settle();
    r.undo.undo();
    assert.equal(r.store.rowIndexOf('r4'), 0, 'the remove undoes at the moved index');
    r.undo.undo();
    assert.equal(r.store.rowIndexOf('r4'), 4, 'then the move undoes');

    // A move record whose row is gone (a later step removed it) stages nothing.
    const skipped = rig();
    skipped.store.removeRow('r2');
    skipped.undo.applyBatch([{ t: 'move', rowKey: 'r2', from: 2, to: 0 }], true);
    assert.deepEqual(skipped.batches, [], 'no op for a row that no longer exists');
    assert.deepEqual(skipped.keys(), ['r0', 'r1', 'r3', 'r4']);
});

await scenario('Alt+Arrow chords are row ops; the drag lands where the insertion line showed', async () => {
    assert.deepEqual(SHARED_KEYMAP['Alt+ArrowUp'], { action: 'rowop', kind: 'moveUp' });
    assert.deepEqual(SHARED_KEYMAP['Alt+ArrowDown'], { action: 'rowop', kind: 'moveDown' });

    assert.equal(RowDragger.targetIndex(1, 3, 'before'), 2);
    assert.equal(RowDragger.targetIndex(1, 3, 'after'), 3);
    assert.equal(RowDragger.targetIndex(3, 0, 'before'), 0);
    assert.equal(RowDragger.targetIndex(3, 0, 'after'), 1);
    assert.equal(RowDragger.targetIndex(2, 2, 'after'), 2);

    const r = rig();
    const listeners = new Map();
    globalThis.window = {
        addEventListener: (type, fn) => listeners.set(type, fn),
        removeEventListener: (type) => listeners.delete(type),
    };
    const rowEl = (key) => r.renderer.body.rowElByKey.get(key);
    // Rows are 24px tall from y = 0; the pointer row is whatever sits under y.
    let under = null;
    globalThis.document.elementFromPoint = () => under;
    r.refs.body.contains = () => true;
    for (const [i, key] of r.keys().entries()) {
        rowEl(key).getBoundingClientRect = () => ({ top: i * 24, height: 24 });
        rowEl(key).closest = (selector) => (selector === '.lgrid-row' ? rowEl(key) : null);
        for (const cell of rowEl(key).children) {
            cell.closest = (selector) => (selector === '.lgrid-cell' ? cell : selector === '.lgrid-row' ? rowEl(key) : null);
        }
    }
    const moves = [];
    const dragger = new RowDragger(r.store, r.refs, (key, to) => { moves.push([key, to]); return r.store.moveRow(key, to); });
    const gutter = r.renderer.cellElFor('r0', '_serial');
    const press = (target, y) => dragger.handlePointerDown({ button: 0, target, clientX: 5, clientY: y });

    press(r.renderer.cellElFor('r0', 'name'), 5);
    assert.equal(dragger.press, null, 'a press off the gutter is not a drag');

    press(gutter, 5);
    listeners.get('pointerup')({});
    assert.deepEqual(moves, [], 'a click without travel moves nothing');

    press(gutter, 5);
    under = rowEl('r3');
    listeners.get('pointermove')({ clientX: 5, clientY: 3 * 24 + 18 });
    assert.equal(rowEl('r3').classes.has('lgrid-row--drop-after'), true, 'the insertion line marks the lower half');
    assert.equal(r.refs.root.classes.has('lgrid--row-dragging'), true);
    listeners.get('pointerup')({});
    assert.deepEqual(moves, [['r0', 3]]);
    assert.deepEqual(r.keys(), ['r1', 'r2', 'r3', 'r0', 'r4']);
    assert.equal(rowEl('r3').classes.has('lgrid-row--drop-after'), false, 'the line is cleared');
    assert.equal(r.refs.root.classes.has('lgrid--row-dragging'), false);

    press(r.renderer.cellElFor('r4', '_serial'), 4 * 24 + 5);
    under = rowEl('r1');
    listeners.get('pointermove')({ clientX: 5, clientY: 2 });
    listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(listeners.has('pointerup'), false, 'Escape disarms the drag');
    assert.equal(rowEl('r1').classes.has('lgrid-row--drop-before'), false);
    assert.deepEqual(moves.length, 1);
});

if (failures.length > 0) {
    console.error(`\nrow-move: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nrow-move OK');
