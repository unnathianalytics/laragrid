/**
 * Node harness: pins the visibleColumns() / columnByKey() memo against the REAL StateStore,
 * ColumnChooser, ViewsManager and SelectionManager.
 *
 *   1. The memo invalidates on every way the hidden set changes: an in-place add/delete/clear
 *      (the chooser), a wholesale assignment (persisted layout, saved view, host scripting).
 *   2. A spy on the column array's filter() proves navigation never re-filters: 100 arrow
 *      moves run the filter at most three times.
 *   3. columnByKey() resolves through the memo and stays correct after an invalidation.
 *
 * Invoke directly: `node tests/js/run-visible-columns.mjs` (also part of `npm test`).
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);

const { default: StateStore } = await load('core/StateStore.js');
const { default: EventBus } = await load('core/EventBus.js');
const { default: ColumnChooser } = await load('render/ColumnChooser.js');
const { default: ViewsManager } = await load('views/ViewsManager.js');
const { default: SelectionManager } = await load('selection/SelectionManager.js');

function rig(rowCount = 3) {
    const store = new StateStore({
        name: 'memo',
        columns: [
            { key: '_serial', visible: true, navigable: false },
            { key: 'a', visible: true, navigable: true },
            { key: 'b', visible: true, navigable: true },
            { key: 'c', visible: true, navigable: true, hiddenByDefault: true },
            { key: 'internal', visible: false },
        ],
        layout: {},
        rows: Array.from({ length: rowCount }, (_, i) => ({ _k: 'r' + i, a: i, b: i * 2, c: i * 3 })),
    }, new EventBus());
    // Count filter runs over the column array (visibleColumns() is the only caller after boot).
    let filterRuns = 0;
    const filter = store.columns.filter;
    store.columns.filter = function countingFilter(...args) {
        filterRuns += 1;
        return filter.apply(this, args);
    };
    return { store, runs: () => filterRuns };
}

const keys = (store) => store.visibleColumns().map((c) => c.key).join(',');

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

await scenario('visibleColumns is memoized and reflects an in-place hidden-set edit', () => {
    const { store, runs } = rig();
    assert.equal(keys(store), '_serial,a,b');
    assert.equal(store.visibleColumns(), store.visibleColumns(), 'same array instance while nothing changed');
    assert.equal(runs(), 1);

    store.userHidden.delete('c');
    assert.equal(keys(store), '_serial,a,b,c', 'delete() invalidates');
    store.userHidden.add('a');
    assert.equal(keys(store), '_serial,b,c', 'add() invalidates');
    assert.equal(store.colIndexOf('c'), 2, 'the visible index map follows');
    assert.equal(store.colIndexOf('a'), -1);
    store.userHidden.clear();
    assert.equal(keys(store), '_serial,a,b,c', 'clear() invalidates');
    assert.equal(runs(), 4);
});

await scenario('a wholesale userHidden assignment invalidates and stays a Set', () => {
    const { store } = rig();
    store.userHidden = new Set(['a', 'b']);
    assert.equal(keys(store), '_serial,c', 'the assigned set replaces the default-hidden set wholesale');
    assert.ok(store.userHidden instanceof Set);
    assert.deepEqual([...store.userHidden], ['a', 'b'], 'spreads like a plain Set (LayoutStore/ViewsManager)');
    assert.deepEqual([...new Set(store.userHidden)], ['a', 'b']);
    store.userHidden = new Set();
    assert.equal(keys(store), '_serial,a,b,c');
});

await scenario('hiding through the column chooser is reflected', () => {
    const { store } = rig();
    const saved = [];
    const chooser = new ColumnChooser(store, { root: { dispatchEvent() {} }, popup: {} }, { isOpen: () => false }, {
        save: (widths, hidden) => saved.push(hidden),
        reset() {},
    }, { onChange() {} });
    chooser.setHidden('b', true);
    assert.equal(keys(store), '_serial,a');
    assert.deepEqual(saved.pop(), ['c', 'b'], 'the persisted hidden list carries the change');
    chooser.setHidden('b', false);
    assert.equal(keys(store), '_serial,a,b');
    chooser.reset();
    assert.equal(keys(store), '_serial,a,b', 'reset restores the declared default-hidden set');
});

await scenario('applying a saved view is reflected', () => {
    const { store } = rig();
    const loads = [];
    const views = new ViewsManager(store, {}, { load: (q) => loads.push(q) }, { enabled: () => false }, {
        onLayoutChanged() {},
    });
    views.apply({ hidden: ['a'], widths: {}, sort: null, search: '', filters: {}, perPage: 50 });
    assert.equal(keys(store), '_serial,b,c');
    assert.equal(loads.length, 1);
    assert.deepEqual(views.capture().hidden, ['a']);
});

await scenario('100 arrow moves run the filter at most three times', () => {
    const { store, runs } = rig(200);
    const selection = new SelectionManager(store, {});
    selection.ensureActive();
    const before = runs();
    for (let i = 0; i < 50; i++) {
        selection.move('down');
    }
    for (let i = 0; i < 50; i++) {
        selection.extend('right');
        selection.extend('left');
    }
    assert.equal(store.active.rowKey, 'r50');
    assert.ok(runs() - before <= 3, `filter ran ${runs() - before} times during navigation`);
});

await scenario('columnByKey resolves through the memo', () => {
    const { store } = rig();
    const a = store.columnByKey('a');
    assert.equal(a, store.columns[1], 'the definition object itself');
    assert.equal(store.columnByKey('internal').visible, false, 'definition-hidden columns resolve too');
    assert.equal(store.columnByKey('ghost'), null);
    store.userHidden.add('a');
    assert.equal(store.columnByKey('a'), a, 'hidden columns still resolve by key');
    store.columns.push({ key: 'late', visible: true });
    store.invalidateColumns();
    assert.equal(store.columnByKey('late').key, 'late', 'invalidateColumns refreshes the key map');
    assert.equal(keys(store), '_serial,b,late');
});

await scenario('visibleGroups recomputes over the memoized index', () => {
    const { store } = rig();
    store.groups = [{ label: 'AB', columns: ['a', 'b'] }, { label: 'C', columns: ['c'] }];
    assert.deepEqual(store.visibleGroups().map((g) => [g.label, g.start, g.span]), [['AB', 1, 2]]);
    store.userHidden.delete('c');
    assert.deepEqual(store.visibleGroups().map((g) => [g.label, g.start, g.span]), [['AB', 1, 2], ['C', 3, 1]]);
});

if (failures.length > 0) {
    console.error(`\nvisible columns: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nvisible columns OK');
