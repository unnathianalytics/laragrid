/**
 * Node harness: pins the small hot-path savings (performance plan J6) against the real
 * modules over the fake DOM.
 *
 *   1. Column resize writes the template at most once per frame and reads the container
 *      width once per drag; pointerup applies the last position.
 *   2. scrollIntoView positions from geometry (row pitch, sticky header/footer, resolved
 *      widths, frozen block) without measuring any element box.
 *   3. paintChecked does nothing while no row is checked, and visits only mounted rows.
 *   4. paintSelect resolves labels through a per-options map built once.
 *   5. Arrow moves never measure the page size; PageDown does.
 *   6. A clean acknowledgement emits no errors:changed; setting or clearing an error does.
 *   7. lockedDependentsOf is computed once; the op log is gone.
 *
 * Invoke directly: `node tests/js/run-hot-path-vectors.mjs` (also part of `npm test`).
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);
const { FakeElement, installFakeDom } = await import(pathToFileURL(resolve(here, 'support', 'fake-dom.mjs')).href);

const dom = installFakeDom();

const { default: EventBus } = await load('core/EventBus.js');
const { default: StateStore } = await load('core/StateStore.js');
const { default: Layout } = await load('render/Layout.js');
const { default: ResizeManager } = await load('resize/ResizeManager.js');
const { default: SelectionPainter } = await load('selection/SelectionPainter.js');
const { default: SelectionManager } = await load('selection/SelectionManager.js');
const { default: ActionRunner } = await load('interact/ActionRunner.js');
const { painterFor } = await load('render/CellPainters.js');

/** A manual animation-frame queue: frames run only when the test says so. */
const frames = [];
globalThis.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
};
globalThis.cancelAnimationFrame = (id) => {
    frames[id - 1] = null;
};
const runFrames = () => {
    const pending = frames.splice(0);
    pending.forEach((callback) => callback && callback());
};

function makeStore(columns, rows = [], layout = {}) {
    return new StateStore({ name: 'hp', columns, rows, layout }, new EventBus());
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

await scenario('a column drag writes the template once per frame and reads the width once', () => {
    const store = makeStore([
        { key: 'a', visible: true, width: 100 },
        { key: 'b', visible: true, grow: true, minWidth: 80 },
        { key: 'c', visible: true, width: 120 },
    ]);
    let widthReads = 0;
    const scroll = new FakeElement();
    Object.defineProperty(scroll, 'clientWidth', { get: () => { widthReads += 1; return 600; } });
    const root = new FakeElement();
    let templates = 0;
    root.style.setProperty = () => { templates += 1; };
    root.querySelectorAll = () => [];
    const refs = { root, scroll, head: new FakeElement(), body: new FakeElement() };
    const layout = new Layout(store, refs);
    layout.setTemplate(store.visibleColumns());
    assert.equal(layout.columnWidth(store.columnByKey('b')), 380, 'grow takes the slack');

    const listeners = new Map();
    const previousWindow = globalThis.window;
    globalThis.window = {
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: (name) => listeners.delete(name),
    };
    const persisted = [];
    const resize = new ResizeManager(store, layout, refs, new EventBus(), { save: (w) => persisted.push({ ...w }) });
    const handle = new FakeElement();
    handle.dataset.col = 'a';
    handle.setPointerCapture = () => {};
    const dispatched = [];
    root.dispatchEvent = (event) => dispatched.push(event.type);

    widthReads = 0;
    templates = 0;
    resize.startDrag(handle, { clientX: 500, pointerId: 1 });
    assert.equal(root.classes.has('lgrid--resizing'), true);
    for (let x = 501; x <= 510; x++) {
        listeners.get('pointermove')({ clientX: x });
    }
    assert.equal(templates, 0, 'nothing is written inside the event burst');
    runFrames();
    assert.equal(templates, 1, 'ten moves in one frame write the template once');
    assert.equal(store.widthOverrides.a, 110, 'at the latest pointer position');
    listeners.get('pointermove')({ clientX: 530 });
    listeners.get('pointermove')({ clientX: 540 });
    listeners.get('pointerup')();
    assert.equal(templates, 2, 'pointerup applies the pending position itself');
    assert.equal(store.widthOverrides.a, 140);
    runFrames();
    assert.equal(templates, 2, 'the cancelled frame does not write again');
    assert.equal(widthReads, 1, 'the container width is read once for the whole drag');
    assert.equal(root.classes.has('lgrid--resizing'), false);
    assert.equal(layout.heldWidth, null, 'the held width is released');
    assert.equal(listeners.size, 0, 'window listeners removed');
    assert.deepEqual(dispatched, ['lgrid:column-resized']);
    assert.equal(persisted.length, 1);
    globalThis.window = previousWindow;
});

await scenario('scrollIntoView follows geometry and measures no element box', () => {
    const columns = [
        { key: 'n', visible: true, navigable: false },
        { key: 'a', visible: true, navigable: true },
        { key: 'b', visible: true, navigable: true },
        { key: 'c', visible: true, navigable: true },
    ];
    const rows = Array.from({ length: 100 }, (_, i) => ({ _k: 'r' + i }));
    const store = makeStore(columns, rows, { freeze: 2 });
    const widths = { n: 40, a: 100, b: 300, c: 300 };
    const scroll = new FakeElement();
    Object.assign(scroll, { clientHeight: 300, clientWidth: 500, scrollTop: 0, scrollLeft: 0 });
    let boxReads = 0;
    const measured = () => { boxReads += 1; return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; };
    scroll.getBoundingClientRect = measured;
    const head = Object.assign(new FakeElement(), { offsetHeight: 30 });
    const footer = Object.assign(new FakeElement(), { offsetHeight: 20, hidden: false });
    const cell = new FakeElement();
    cell.getBoundingClientRect = measured;
    const renderer = {
        body: { rowHeightPx: () => 25 },
        layout: { columnWidth: (column) => widths[column.key] },
        cellElFor: () => cell,
        ensureCellElFor: () => cell,
    };
    const painter = new SelectionPainter(store, renderer, store.bus, { root: new FakeElement(), scroll, head, footer });

    // Visible band for rows: [scrollTop + 30, scrollTop + 300 - 20] → rows 0..9 at scrollTop 0.
    store.setActive({ rowKey: 'r9', colKey: 'a' });
    assert.equal(scroll.scrollTop, 0, 'row 9 (ends at 280) is fully visible above the footer');
    store.setActive({ rowKey: 'r10', colKey: 'a' });
    assert.equal(scroll.scrollTop, 25, 'row 10 scrolls just clear of the sticky footer');
    store.setActive({ rowKey: 'r50', colKey: 'a' });
    assert.equal(scroll.scrollTop, 30 + (51 * 25) - 300 + 20);
    store.setActive({ rowKey: 'r20', colKey: 'a' });
    assert.equal(scroll.scrollTop, 20 * 25, 'moving up lands the row just under the sticky header');

    // Horizontal: the frozen block (n + a = 140px) covers the left edge.
    store.setActive({ rowKey: 'r20', colKey: 'c' });
    assert.equal(scroll.scrollLeft, 40 + 100 + 300 + 300 - 500, 'c (440..740) scrolls in on the right');
    store.setActive({ rowKey: 'r20', colKey: 'b' });
    assert.equal(scroll.scrollLeft, 0, 'b (140..440) must clear the frozen block');
    scroll.scrollLeft = 200;
    store.setActive({ rowKey: 'r20', colKey: 'a' });
    assert.equal(scroll.scrollLeft, 200, 'a frozen cell never scrolls horizontally');
    assert.equal(boxReads, 0, 'no getBoundingClientRect');
    painter.destroy();
});

await scenario('paintChecked skips work while nothing is checked and visits mounted rows only', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ _k: 'r' + i }));
    const store = makeStore([{ key: '_select', visible: true }], rows);
    const cells = new Map();
    let lookups = 0;
    const mounted = new Map(rows.slice(0, 40).map((row) => [row._k, new FakeElement()]));
    const renderer = {
        body: { rowElByKey: mounted },
        cellElFor: (rowKey) => {
            lookups += 1;
            if (!mounted.has(rowKey)) {
                return null;
            }
            if (!cells.has(rowKey)) {
                cells.set(rowKey, new FakeElement());
            }
            return cells.get(rowKey);
        },
    };
    const refs = { root: new FakeElement(), body: new FakeElement() };
    const runner = new ActionRunner(store, renderer, store.bus, refs, { actions: {} });
    runner.init();
    store.bus.emit('body:did-render');
    assert.equal(lookups, 0, 'no checked row: no lookups');

    store.toggleChecked('r3');
    assert.equal(lookups, 40, 'only the mounted rows are visited');
    assert.equal(cells.get('r3').classes.has('lgrid-cell--checked'), true);
    store.toggleChecked('r3');
    assert.equal(cells.get('r3').classes.has('lgrid-cell--checked'), false, 'unchecking clears the mark');
    lookups = 0;
    store.bus.emit('body:did-render');
    assert.equal(lookups, 0, 'back to no work once nothing is checked or painted');
    runner.destroy();
});

await scenario('paintSelect builds its label map once per options list', () => {
    let reads = 0;
    const option = (value, label) => ({ get value() { reads += 1; return value; }, label });
    const column = { key: 'st', options: [option(1, 'Open'), option('2', 'Closed'), option(1, 'Shadowed')] };
    const paint = painterFor('select');
    const cell = new FakeElement();
    for (let i = 0; i < 100; i++) {
        paint(cell, { value: i % 2 ? '1' : 2, column, row: {} });
    }
    assert.equal(reads, 3, 'each option is read once, not once per cell');
    paint(cell, { value: 1, column, row: {} });
    assert.equal(cell.textContent, 'Open', 'the first option with a value wins');
    paint(cell, { value: 'x', column, row: { _labels: { st: 'Picked' } } });
    assert.equal(cell.textContent, 'Picked', 'unknown values fall back to the row label');
    paint(cell, { value: 'y', column, row: {} });
    assert.equal(cell.textContent, 'y');
    paint(cell, { value: null, column, row: {} });
    assert.equal(cell.textContent, '');
    column.options = [{ value: 1, label: 'Reopened' }];
    paint(cell, { value: 1, column, row: {} });
    assert.equal(cell.textContent, 'Reopened', 'a replaced options list gets a fresh map');
});

await scenario('arrow moves never measure the page size; PageDown does', () => {
    const store = makeStore(
        [{ key: 'a', visible: true, navigable: true }],
        Array.from({ length: 50 }, (_, i) => ({ _k: 'r' + i })),
    );
    const scroll = Object.assign(new FakeElement(), { clientHeight: 240 });
    const selection = new SelectionManager(store, { root: new FakeElement(), scroll, body: new FakeElement() });
    store.setActive({ rowKey: 'r0', colKey: 'a' });
    dom.reads = 0;
    for (let i = 0; i < 20; i++) {
        selection.resolve('down');
    }
    assert.equal(dom.reads, 0, 'no getComputedStyle for arrow intents');
    assert.ok(selection.resolve('pageDown').row > 1);
    assert.ok(dom.reads > 0, 'the page intent measures');
});

await scenario('errors:changed fires only when an error is set or cleared', () => {
    const store = makeStore([{ key: 'name', visible: true, editable: true }], [{ _k: 'r1', name: '' }], { editable: true });
    let emits = 0;
    store.bus.on('errors:changed', () => { emits += 1; });
    const ack = (seq, extra = {}) => store.reconcile(
        { version: seq, results: [{ seq, ok: true, patch: {}, errors: {}, ...extra }] },
        [{ op: { seq }, cells: [{ rowKey: 'r1', colKey: 'name' }] }],
    );
    store.applyLocalSet('r1', 'name', 'ok');
    store.markPending([{ rowKey: 'r1', colKey: 'name' }], 1);
    ack(1);
    assert.equal(emits, 0, 'a clean acknowledgement does not rebuild the error panel');

    store.applyLocalSet('r1', 'name', 'bad');
    store.markPending([{ rowKey: 'r1', colKey: 'name' }], 2);
    ack(2, { ok: false, errors: { r1: { name: 'Too long' } } });
    assert.equal(emits, 1, 'a new error is announced');
    assert.equal(store.errorFor('r1', 'name'), 'Too long');

    store.applyLocalSet('r1', 'name', 'fine');
    store.markPending([{ rowKey: 'r1', colKey: 'name' }], 3);
    ack(3);
    assert.equal(emits, 2, 'clearing it is announced');
    assert.equal(store.errorFor('r1', 'name'), null);
});

await scenario('lockedDependentsOf is computed once; there is no op log', () => {
    const store = makeStore([
        { key: 'dc', visible: true },
        { key: 'dr', visible: true, lockedWhen: { column: 'dc', in: ['C'] } },
        { key: 'cr', visible: true, lockedWhen: { column: 'dc', in: ['D'] } },
        { key: 'memo', visible: true },
    ]);
    const first = store.lockedDependentsOf('dc');
    assert.deepEqual(first, ['dr', 'cr']);
    assert.equal(store.lockedDependentsOf('dc'), first, 'the same precomputed list');
    assert.deepEqual(store.lockedDependentsOf('memo'), []);
    store.userHidden = new Set(['memo']);
    assert.deepEqual(store.lockedDependentsOf('dc'), ['dr', 'cr'], 'rebuilt after a column change');
    assert.equal('opLog' in store, false);
});

dom.restore();
delete globalThis.requestAnimationFrame;
delete globalThis.cancelAnimationFrame;

if (failures.length > 0) {
    console.error(`\nhot path: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nhot path OK');
