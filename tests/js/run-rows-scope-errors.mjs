/**
 * Node harness: pins grid-level validation results (plan F5, `scope: 'rows'`) on the REAL
 * StateStore, SyncManager and ErrorPainter over the fake DOM.
 *
 *   1. A scoped result sets a grid message (`_grid_row`), a row message and a cell message;
 *      canSave() turns false. The next scoped result with no errors clears all three and
 *      canSave() turns true again.
 *   2. A scoped result never settles the op's cells: an op-level error on the same seq stays.
 *   3. A cell message superseded by a newer local edit of that cell is skipped.
 *   4. clearRowState (a removed row) drops that row's scoped keys; reseed drops all of them.
 *   5. The error panel reads "Grid — message" for a grid-level entry, sorts it first, and
 *      focusing it lands on the first navigable cell and announces the message.
 *
 * Invoke directly: `node tests/js/run-rows-scope-errors.mjs` (also part of `npm test`).
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
const { default: SyncManager } = await load('sync/SyncManager.js');
const { default: ErrorPainter } = await load('render/ErrorPainter.js');
const { cellMapKey } = await load('util/dom.js');

const tick = () => new Promise((r) => setTimeout(r, 5));

function rig() {
    const bus = new EventBus();
    const store = new StateStore({
        name: 'lines',
        columns: [
            { key: '_serial', label: '#', visible: true, navigable: false, painter: 'serial' },
            { key: 'item_id', label: 'Item', visible: true, editable: true, writable: true, navigable: true },
            { key: 'qty', label: 'Qty', visible: true, editable: true, writable: true, navigable: true },
        ],
        rows: [
            { _k: 'a', item_id: 'i1', qty: 1 },
            { _k: 'b', item_id: 'i1', qty: 2 },
            { _k: 'c', item_id: 'i2', qty: 3 },
        ],
        layout: { editable: true, sync: 'deferred' },
    }, bus);
    const sync = new SyncManager(store, bus, { gridOps: async () => ({}) });
    const scoped = (seq, errors) => ({ seq, ok: Object.keys(errors).length === 0, scope: 'rows', patch: [], errors });
    const respond = (results, items = []) => store.reconcile({ version: 1, results }, items);
    return { bus, store, sync, scoped, respond };
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

await scenario('a scoped result sets grid, row and cell messages; the next empty one clears them', () => {
    const r = rig();
    const changes = [];
    r.bus.on('errors:changed', ({ keys }) => changes.push([...keys].sort()));
    assert.equal(r.sync.canSave(), true);

    r.respond([r.scoped(4, {
        _grid: { _row: 'At least one credit line.' },
        a: { _row: 'Check this line.' },
        b: { item_id: 'Duplicate.' },
    })]);
    assert.equal(r.store.errors.get('_grid_row'), 'At least one credit line.');
    assert.equal(r.store.errorFor('a', '_row'), 'Check this line.');
    assert.equal(r.store.errorFor('b', 'item_id'), 'Duplicate.');
    assert.equal(r.store.rowsScopedErrors.size, 3);
    assert.equal(r.sync.canSave(), false, 'a grid-level message blocks Save');

    r.respond([r.scoped(5, {})]);
    assert.equal(r.store.errors.size, 0);
    assert.equal(r.store.rowsScopedErrors.size, 0);
    assert.equal(r.sync.canSave(), true);
    assert.deepEqual(changes.at(-1), ['_grid_row', 'a_row', cellMapKey('b', 'item_id')].sort());
});

await scenario('a scoped result never settles the op cells sharing its seq', () => {
    const r = rig();
    const op = { seq: 7, t: 'set', row: 'c', col: 'qty', v: 'x' };
    const cells = [{ rowKey: 'c', colKey: 'qty' }];
    r.store.applyLocalSet('c', 'qty', 'x');
    r.store.markPending(cells, 7);
    r.respond([
        { seq: 7, ok: false, patch: [], errors: { c: { qty: 'The qty must be an integer.' } } },
        r.scoped(7, {}),
    ], [{ op, cells }]);
    assert.equal(r.store.errorFor('c', 'qty'), 'The qty must be an integer.', 'the op error stays');
    assert.equal(r.store.dirty.has(cellMapKey('c', 'qty')), true);

    // An op-level error owns its key: a scoped message for the same cell does not replace it,
    // and the next scoped result does not clear it.
    r.respond([r.scoped(8, { c: { qty: 'Too many.' } })]);
    assert.equal(r.store.errorFor('c', 'qty'), 'The qty must be an integer.');
    r.respond([r.scoped(9, {})]);
    assert.equal(r.store.errorFor('c', 'qty'), 'The qty must be an integer.');
});

await scenario('a cell message superseded by a newer local edit is skipped', () => {
    const r = rig();
    r.store.applyLocalSet('b', 'item_id', 'i3');
    r.store.markPending([{ rowKey: 'b', colKey: 'item_id' }], 12);
    r.respond([r.scoped(11, { b: { item_id: 'Duplicate.' }, _grid: { _row: 'Unbalanced.' } })]);
    assert.equal(r.store.errorFor('b', 'item_id'), null, 'the operator already retyped the cell');
    assert.equal(r.store.errors.get('_grid_row'), 'Unbalanced.', 'grid messages always land');
});

await scenario('a removed row drops its scoped keys; a reseed drops them all', () => {
    const r = rig();
    r.respond([r.scoped(3, { b: { item_id: 'Duplicate.', _row: 'Row.' }, c: { qty: 'Odd.' } })]);
    r.store.removeRow('b');
    assert.equal(r.store.errorFor('b', 'item_id'), null);
    assert.deepEqual([...r.store.rowsScopedErrors], [cellMapKey('c', 'qty')]);
    r.store.reseed([{ _k: 'z', item_id: null, qty: null }]);
    assert.equal(r.store.rowsScopedErrors.size, 0);
});

await scenario('the panel reads "Grid — message" first; focusing it lands on the first cell', async () => {
    const r = rig();
    const list = new FakeElement('ul');
    list.querySelector = () => null;
    const refs = { root: new FakeElement(), errorList: list, announcer: new FakeElement() };
    refs.root.focus = () => {};
    const painter = new ErrorPainter(r.store, { cellElFor: () => null }, r.bus, refs);
    r.store.setActive({ rowKey: 'c', colKey: 'qty' });
    r.respond([r.scoped(2, { b: { item_id: 'Duplicate.' }, _grid: { _row: 'At least one credit line.' } })]);
    await tick();
    const texts = list.children.map((item) => item.children[0].textContent);
    assert.deepEqual(texts, ['Grid — At least one credit line.', 'Row 2 · Item — Duplicate.']);

    painter.focusError(0);
    assert.deepEqual(r.store.active, { rowKey: 'a', colKey: 'item_id' }, 'the first navigable cell');
    assert.equal(refs.announcer.textContent, 'Grid: At least one credit line.');
    painter.focusError(1);
    assert.deepEqual(r.store.active, { rowKey: 'b', colKey: 'item_id' });
    painter.destroy();
});

if (failures.length > 0) {
    console.error(`\nrows-scope errors: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nrows-scope errors OK');
process.exit(0);
