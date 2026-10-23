/**
 * Node harness: pins the virtual row window (BodyRenderer) against a fake DOM, the way
 * run-editable-reliability.mjs does — no jsdom.
 *
 *   1. Hysteresis: a one-row scroll inside the overscan dead band builds nothing.
 *   2. Recycle: a scroll past the buffer builds ONLY the rows that enter, removes the rows that
 *      leave, keeps rowElByKey/cellElByKey sized to the mounted rows, and resizes the spacers.
 *   3. Jump: ensureCellElFor() on an unmounted row scrolls first and builds the window once;
 *      the scroll event it raises finds the window already in place.
 *   4. The row pitch is measured once and re-measured only after Layout reports a metrics change.
 *   5. body:window-rendered carries {added, removed}; SelectionPainter and ErrorPainter touch
 *      only the rows that entered (and never scroll the active cell on a window shift).
 *
 * Invoke directly: `node tests/js/run-virtual-window.mjs` (also part of `npm test`).
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);
const { FakeElement, installFakeDom } = await import(pathToFileURL(resolve(here, 'support', 'fake-dom.mjs')).href);

/* ------------------------------------------------------------------ fake DOM */

const dom = installFakeDom();
const styleReads = () => dom.reads;

const { default: EventBus } = await load('core/EventBus.js');
const { default: StateStore } = await load('core/StateStore.js');
const { default: BodyRenderer } = await load('render/BodyRenderer.js');
const { default: Layout } = await load('render/Layout.js');
const { default: SelectionPainter } = await load('selection/SelectionPainter.js');
const { default: ErrorPainter } = await load('render/ErrorPainter.js');

const tick = () => new Promise((r) => setTimeout(r, 2));

function rig(rowCount = 2000) {
    const bus = new EventBus();
    const store = new StateStore({
        name: 'vw',
        columns: [
            { key: '_serial', visible: true, navigable: false, painter: 'serial' },
            { key: 'name', visible: true, editable: true, navigable: true, painter: 'text' },
            { key: 'qty', visible: true, editable: true, navigable: true, painter: 'text' },
        ],
        rows: Array.from({ length: rowCount }, (_, index) => ({ _k: 'r' + index, name: 'N' + index, qty: index })),
        layout: { editable: true },
    }, bus);
    const root = new FakeElement();
    const scroll = new FakeElement();
    scroll.clientHeight = 240; // 10 rows of 24px
    scroll.scrollTop = 0;
    const head = new FakeElement();
    head.offsetHeight = 24;
    const body = new FakeElement();
    const metrics = new Set();
    const layout = {
        refs: { root, scroll, head, body },
        applyFrozenTo() {},
        fillerCell: () => new FakeElement(),
        onMetricsChanged: (fn) => { metrics.add(fn); return () => metrics.delete(fn); },
        notifyMetricsChanged: () => metrics.forEach((fn) => fn()),
    };
    const renderer = new BodyRenderer(store, layout, body, bus);
    let built = 0;
    const buildRow = renderer.buildRow.bind(renderer);
    renderer.buildRow = (...args) => { built += 1; return buildRow(...args); };
    const windows = [];
    bus.on('body:window-rendered', (delta) => windows.push(delta));
    const scrollTo = async (top) => {
        scroll.scrollTop = top;
        renderer.onScroll();
        await tick();
    };
    const rowKeys = () => body.children.filter((c) => c.classes.has('lgrid-row')).map((c) => c.dataset.k);
    return { bus, store, layout, renderer, body, scroll, root, built: () => built, windows, scrollTo, rowKeys };
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

function assertMountedWindow(r, start, end) {
    const keys = r.rowKeys();
    assert.equal(r.renderer.windowStart, start);
    assert.equal(r.renderer.windowEnd, end);
    assert.deepEqual([keys[0], keys[keys.length - 1]], ['r' + start, 'r' + (end - 1)], 'DOM order matches the window');
    assert.equal(keys.length, end - start, 'exactly the window is in the DOM');
    assert.equal(r.renderer.rowElByKey.size, end - start, 'rowElByKey sized to the mounted rows');
    assert.equal(r.renderer.cellElByKey.size, (end - start) * 3, 'cellElByKey sized to the mounted cells');
    for (const key of keys) {
        assert.ok(r.renderer.rowElByKey.has(key), `rowElByKey has ${key}`);
    }
    const top = r.body.children[0];
    const bottom = r.body.children[r.body.children.length - 1];
    if (start > 0) {
        assert.equal(top.style.height, (start * 24) + 'px', 'top spacer height');
        assert.equal(top, r.renderer.topSpacer);
    } else {
        assert.equal(r.renderer.topSpacer, null);
        assert.ok(top.classes.has('lgrid-row'));
    }
    if (end < r.store.rowCount()) {
        assert.equal(bottom.style.height, ((r.store.rowCount() - end) * 24) + 'px', 'bottom spacer height');
        assert.equal(bottom, r.renderer.bottomSpacer);
    } else {
        assert.equal(r.renderer.bottomSpacer, null);
    }
}

await scenario('initial virtual paint mounts viewport + overscan', () => {
    const r = rig();
    r.renderer.render();
    assert.equal(r.renderer.virtual, true);
    assert.equal(r.built(), 50, '10 visible + 2 x 20 overscan');
    assertMountedWindow(r, 0, 50);
    assert.equal(r.renderer.rowElByKey.get('r7').getAttribute('aria-rowindex'), '9');
});

await scenario('a one-row scroll inside the dead band builds nothing', async () => {
    const r = rig();
    r.renderer.render();
    await r.scrollTo(24 + 24); // head + one row
    assert.equal(r.built(), 50, 'no row built');
    assert.equal(r.windows.length, 0, 'no window event');
    await r.scrollTo(24 + (24 * 29)); // first visible 29, last 38: still inside [10, 39]
    assert.equal(r.built(), 50);
    assertMountedWindow(r, 0, 50);
});

await scenario('a scroll past the buffer builds only the delta and recycles the rest', async () => {
    const r = rig();
    r.renderer.render();
    const kept = r.renderer.rowElByKey.get('r40');
    await r.scrollTo(24 + (24 * 45)); // first visible 45 → window [25, 75)
    assert.equal(r.built(), 75, '25 rows entered, built once each');
    assertMountedWindow(r, 25, 75);
    assert.equal(r.renderer.rowElByKey.get('r40'), kept, 'a kept row keeps its element');
    assert.equal(kept.parentNode, r.body);
    assert.equal(r.windows.length, 1);
    assert.deepEqual(r.windows[0].removed, Array.from({ length: 25 }, (_, i) => 'r' + i));
    assert.deepEqual(r.windows[0].added, Array.from({ length: 25 }, (_, i) => 'r' + (50 + i)));
    assert.equal(r.renderer.cellElFor('r0', 'name'), null, 'removed rows leave the cell index');
    assert.ok(r.renderer.cellElFor('r74', 'qty'), 'entered rows join the cell index');

    // Back up past the top edge: rows re-enter above, rows leave below.
    await r.scrollTo(24 + (24 * 30)); // first visible 30 → window [10, 60)
    assert.equal(r.built(), 90, '15 rows re-entered above');
    assertMountedWindow(r, 10, 60);
    assert.deepEqual(r.windows[1].added, Array.from({ length: 15 }, (_, i) => 'r' + (10 + i)));
    assert.deepEqual(r.windows[1].removed, Array.from({ length: 15 }, (_, i) => 'r' + (60 + i)));

    // All the way home: the top spacer goes away.
    await r.scrollTo(0);
    assertMountedWindow(r, 0, 50);
    assert.equal(r.built(), 100);
});

await scenario('a jump to an unmounted row scrolls first and renders once', async () => {
    const r = rig();
    r.renderer.render();
    const cell = r.renderer.ensureCellElFor('r1500', 'name');
    assert.ok(cell, 'the cell is mounted');
    assert.equal(r.built(), 100, 'one full window build for a no-overlap jump');
    assert.equal(r.windows.length, 1, 'one window event');
    assert.equal(r.scroll.scrollTop, 24 + (1500 * 24) - 108, 'scroll position set to centre the row');
    assertMountedWindow(r, 1475, 1525); // first visible = floor((35916 - 24) / 24) = 1495
    assert.equal(r.windows[0].added.length, 50);
    assert.equal(r.windows[0].removed.length, 50);

    // The scroll event raised by the scrollTop write finds the window already in place.
    r.renderer.onScroll();
    await tick();
    assert.equal(r.built(), 100, 'the follow-up scroll event rebuilt nothing');
    assert.equal(r.windows.length, 1);
    assert.equal(r.renderer.ensureCellElFor('r1500', 'name'), cell, 'a mounted row never re-renders');

    // A jump that overlaps the window shifts by delta.
    r.renderer.ensureCellElFor('r1530', 'qty');
    assertMountedWindow(r, 1505, 1555);
    assert.equal(r.built(), 130, 'only the 30 entering rows were built');
});

await scenario('the row pitch is measured once until Layout reports a metrics change', async () => {
    const r = rig();
    dom.reads = 0;
    r.renderer.render();
    await r.scrollTo(24 + (24 * 45));
    await r.scrollTo(24 + (24 * 90));
    assert.equal(styleReads(), 2, 'root + documentElement, once');
    r.layout.notifyMetricsChanged();
    assert.equal(r.renderer.rowHeight, null, 'cache dropped');
    r.renderer.rowHeightPx();
    assert.equal(styleReads(), 4, 're-measured after the change');
    r.renderer.destroy();
    r.layout.notifyMetricsChanged();
    assert.equal(r.renderer.rowHeight, 24, 'destroy() unsubscribes');
});

await scenario('Layout.apply() and a resize notify metrics listeners', () => {
    const bus = new EventBus();
    const store = new StateStore({ name: 'l', columns: [{ key: 'a', visible: true, width: 100 }], rows: [], layout: { density: 'compact' } }, bus);
    const root = new FakeElement();
    root.style.setProperty = (k, v) => { root.style[k] = v; };
    const scroll = new FakeElement();
    scroll.clientWidth = 800;
    const body = new FakeElement();
    const layout = new Layout(store, { root, scroll, head: new FakeElement(), body });
    let notified = 0;
    const off = layout.onMetricsChanged(() => { notified += 1; });
    layout.apply();
    assert.equal(notified, 1, 'apply() (density/theme class writes) notifies');
    assert.ok(root.classes.has('lgrid--compact'));
    off();
    layout.apply();
    assert.equal(notified, 1, 'unsubscribed');
});

await scenario('painters reassert only the rows that entered', async () => {
    const r = rig();
    r.renderer.render();
    const rendererFacade = {
        body: r.renderer,
        cellElFor: (k, c) => r.renderer.cellElFor(k, c),
        ensureCellElFor: (k, c) => r.renderer.ensureCellElFor(k, c),
    };
    const painter = new SelectionPainter(r.store, rendererFacade, r.bus, { root: r.root, scroll: r.scroll });
    let scrolled = 0;
    painter.scrollIntoView = () => { scrolled += 1; };
    let toggles = 0;
    const toggleSelected = painter.toggleSelected.bind(painter);
    painter.toggleSelected = (cell, on) => { if (cell) toggles += 1; toggleSelected(cell, on); };

    // Whole 'name' column selected (col index 1), active cell far below the window.
    r.store.active = { rowKey: 'r60', colKey: 'name' };
    r.store.anchor = { rowKey: 'r0', colKey: 'name' };
    r.store.selection = { r0: 0, r1: 1999, c0: 1, c1: 1, kind: 'col' };
    painter.paintSelection();
    assert.equal(toggles, 50, 'only the mounted window is painted');
    assert.ok(r.renderer.cellElFor('r10', 'name').classes.has('lgrid-cell--selected'));
    assert.equal(painter.activeEl, null, 'active row not mounted yet');

    const errors = new ErrorPainter(r.store, rendererFacade, r.bus, { root: r.root });
    r.store.errors.set(r.store.errorKey('r60', 'qty'), 'bad');
    r.store.errors.set(r.store.errorKey('r0', 'qty'), 'bad');
    r.store.dirty.add(r.store.errorKey('r70', 'name'));
    const scheduled = [];
    const schedule = errors.schedule.bind(errors);
    errors.schedule = (keys) => { scheduled.push([...keys]); schedule(keys); };

    toggles = 0;
    await r.scrollTo(24 + (24 * 45)); // → [25, 75): r50..r74 enter
    assert.equal(toggles, 25, 'only the entering rows received the selected class');
    assert.ok(r.renderer.cellElFor('r74', 'name').classes.has('lgrid-cell--selected'));
    assert.ok(r.renderer.cellElFor('r40', 'name').classes.has('lgrid-cell--selected'), 'kept rows keep theirs');
    assert.equal(painter.activeEl, r.renderer.cellElFor('r60', 'name'), 'the active ring landed on the entered row');
    assert.ok(painter.activeEl.classes.has('lgrid-cell--active'));
    assert.equal(scrolled, 0, 'a window shift never scrolls the active cell');
    assert.deepEqual(scheduled.pop().sort(), [r.store.errorKey('r60', 'qty'), r.store.errorKey('r70', 'name')].sort(),
        'ErrorPainter schedules only the entered rows\' state keys');
    await tick();
    assert.ok(r.renderer.cellElFor('r60', 'qty').classes.has('lgrid-cell--error'));
    assert.ok(r.renderer.cellElFor('r70', 'name').classes.has('lgrid-cell--dirty'));

    // Scroll the active row back out: the painter forgets the detached element.
    await r.scrollTo(24 + (24 * 120));
    assert.equal(painter.activeEl, null);

    // Selection diff arithmetic: shrinking the rect by one row toggles ONE strip off.
    await r.scrollTo(0);
    toggles = 0;
    r.store.selection = { r0: 0, r1: 1998, c0: 1, c1: 1, kind: 'range' };
    painter.paintSelection();
    assert.equal(toggles, 0, 'row 1999 is not mounted — nothing to untoggle');
    r.store.selection = { r0: 0, r1: 30, c0: 1, c1: 2, kind: 'range' };
    painter.paintSelection();
    assert.equal(toggles, 19 + 31, '19 rows left the column strip, 31 cells entered the qty column');
    assert.equal(r.renderer.cellElFor('r31', 'name').classes.has('lgrid-cell--selected'), false);
    assert.ok(r.renderer.cellElFor('r30', 'qty').classes.has('lgrid-cell--selected'));
    r.store.selection = null;
    painter.paintSelection();
    assert.equal(painter.paintedRect, null);
    assert.equal(r.renderer.cellElFor('r30', 'qty').classes.has('lgrid-cell--selected'), false);
    painter.destroy();
    errors.destroy();
});

if (failures.length > 0) {
    console.error(`\nvirtual window: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nvirtual window OK');
