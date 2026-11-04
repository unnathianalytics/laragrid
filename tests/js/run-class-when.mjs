/**
 * Node harness: pins live conditional formatting (plan F2) on the REAL StateStore and Renderer
 * over the fake DOM.
 *
 *   1. Declarative classes: a `dc` flip toggles the `cr` cell's `classWhen` class and the row's
 *      `rowClassWhen` class in place, with no body rebuild; a server `_cellClass` / `_rowClass`
 *      on the same elements survives the swap.
 *   2. A change to a column that controls nothing repaints nothing extra.
 *   3. classDependentsOf is built once and rebuilt after a column change.
 *   4. A reconcile patch carrying `_cellClass` / `_rowClass` (a rowClass()/cellClass() closure
 *      refreshed by the server) repaints exactly the cells whose class came or went, and the row.
 *
 * Invoke directly: `node tests/js/run-class-when.mjs` (also part of `npm test`).
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

const settle = () => new Promise((r) => setTimeout(r, 2));

function rig() {
    const bus = new EventBus();
    const store = new StateStore({
        name: 'cw',
        columns: [
            { key: '_serial', visible: true, navigable: false, painter: 'serial' },
            { key: 'dc', visible: true, editable: true, writable: true, navigable: true, painter: 'text' },
            { key: 'dr', visible: true, editable: true, writable: true, navigable: true, painter: 'text' },
            {
                key: 'cr', visible: true, editable: true, writable: true, navigable: true, painter: 'text',
                classWhen: [
                    { column: 'dc', in: ['C'], class: 'is-credit' },
                    { column: 'dc', in: ['C', 'X'], class: 'is-active strong' },
                ],
            },
            { key: 'memo', visible: true, editable: true, writable: true, navigable: true, painter: 'text' },
        ],
        rows: [
            { _k: 'r1', dc: 'D', dr: '10', cr: '', memo: '', _rowClass: 'from-server', _cellClass: { cr: 'srv-cr' } },
            { _k: 'r2', dc: 'C', dr: '', cr: '5', memo: '' },
        ],
        layout: { editable: true, rowClassWhen: [{ column: 'dc', in: ['C'], class: 'row-credit' }] },
    }, bus);
    const refs = { root: new FakeElement(), scroll: new FakeElement(), head: new FakeElement(), body: new FakeElement(), footer: new FakeElement() };
    refs.scroll.clientHeight = 240;
    refs.head.offsetHeight = 24;
    const renderer = new Renderer(store, { refs, applyFrozenTo() {}, fillerCell: () => new FakeElement() }, refs, bus);
    let renders = 0;
    const render = renderer.body.render.bind(renderer.body);
    renderer.body.render = () => { renders += 1; render(); };
    renderer.renderBody();

    const repainted = [];
    const repaintCell = renderer.body.repaintCell.bind(renderer.body);
    renderer.body.repaintCell = (rowKey, colKey) => { repainted.push(`${rowKey}.${colKey}`); return repaintCell(rowKey, colKey); };
    const rowRepaints = [];
    const repaintRow = renderer.body.repaintRowClasses.bind(renderer.body);
    renderer.body.repaintRowClasses = (rowKey) => { rowRepaints.push(rowKey); return repaintRow(rowKey); };

    const cell = (rowKey, colKey) => renderer.body.cellElFor(rowKey, colKey).classes;
    const row = (rowKey) => renderer.body.rowElByKey.get(rowKey).classes;
    return { bus, store, renderer, renders: () => renders, repainted, rowRepaints, cell, row };
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

await scenario('the build paints server and declarative classes together', () => {
    const r = rig();
    assert.ok(r.row('r1').has('from-server'));
    assert.ok(!r.row('r1').has('row-credit'));
    assert.ok(r.cell('r1', 'cr').has('srv-cr'));
    assert.ok(!r.cell('r1', 'cr').has('is-credit'));
    assert.ok(r.row('r2').has('row-credit'));
    for (const name of ['is-credit', 'is-active', 'strong']) {
        assert.ok(r.cell('r2', 'cr').has(name), `r2.cr has ${name}`);
    }
    assert.ok(!r.cell('r2', 'dr').has('is-credit'), 'a column without classWhen gets nothing');
});

await scenario('a dc flip toggles the cell and row classes in place, keeping server classes', async () => {
    const r = rig();
    r.store.applyLocalSet('r1', 'dc', 'C');
    await settle();
    assert.equal(r.renders(), 1, 'no body rebuild');
    assert.ok(r.cell('r1', 'cr').has('is-credit'));
    assert.ok(r.cell('r1', 'cr').has('strong'));
    assert.ok(r.cell('r1', 'cr').has('srv-cr'), 'the server cell class survives');
    assert.ok(r.row('r1').has('row-credit'));
    assert.ok(r.row('r1').has('from-server'), 'the server row class survives');
    assert.ok(r.cell('r1', 'cr').has('lgrid-cell'), 'engine classes are untouched');
    assert.deepEqual(r.rowRepaints, ['r1']);

    r.store.applyLocalSet('r1', 'dc', 'X');
    await settle();
    assert.ok(!r.cell('r1', 'cr').has('is-credit'), 'the C-only class is removed');
    assert.ok(r.cell('r1', 'cr').has('is-active'), 'the C/X class stays');
    assert.ok(!r.row('r1').has('row-credit'));
    assert.ok(r.row('r1').has('from-server'));

    r.store.applyLocalSet('r1', 'dc', 'D');
    await settle();
    for (const name of ['is-credit', 'is-active', 'strong']) {
        assert.ok(!r.cell('r1', 'cr').has(name), `r1.cr lost ${name}`);
    }
    assert.ok(r.cell('r1', 'cr').has('srv-cr'));
});

await scenario('a change to a column that controls nothing repaints nothing extra', async () => {
    const r = rig();
    r.store.applyLocalSet('r1', 'memo', 'note');
    await settle();
    assert.deepEqual(r.repainted, ['r1.memo']);
    assert.deepEqual(r.rowRepaints, []);
});

await scenario('classDependentsOf is built once and rebuilt after a column change', () => {
    const r = rig();
    const first = r.store.classDependentsOf('dc');
    assert.deepEqual(first, { cells: ['cr'], row: true });
    assert.equal(r.store.classDependentsOf('dc'), first, 'the same precomputed entry');
    assert.deepEqual(r.store.classDependentsOf('memo'), { cells: [], row: false });
    r.store.userHidden = new Set(['memo']);
    assert.notEqual(r.store.classDependentsOf('dc'), first, 'rebuilt after a column change');
    assert.deepEqual(r.store.classDependentsOf('dc'), first);
});

await scenario('a reconciled _cellClass / _rowClass patch repaints exactly what changed', async () => {
    const r = rig();
    r.store.reconcile({
        version: 1,
        results: [{
            seq: 1,
            ok: true,
            errors: {},
            patch: { r1: { _cellClass: { dr: 'srv-dr' }, _rowClass: 'refreshed' } },
        }],
    }, []);
    await settle();
    assert.deepEqual(r.repainted.sort(), ['r1.cr', 'r1.dr'], 'cr lost its class, dr gained one');
    assert.deepEqual(r.rowRepaints, ['r1']);
    assert.ok(r.cell('r1', 'dr').has('srv-dr'));
    assert.ok(!r.cell('r1', 'cr').has('srv-cr'));
    assert.ok(r.row('r1').has('refreshed'));
    assert.ok(!r.row('r1').has('from-server'));

    r.repainted.length = 0;
    r.rowRepaints.length = 0;
    r.store.reconcile({
        version: 2,
        results: [{ seq: 2, ok: true, errors: {}, patch: { r1: { _cellClass: [], _rowClass: null } } }],
    }, []);
    await settle();
    assert.deepEqual(r.repainted, ['r1.dr'], 'an empty list clears the map');
    assert.ok(!r.cell('r1', 'dr').has('srv-dr'));
    assert.ok(!r.row('r1').has('refreshed'));
    assert.equal(r.store.rowByKey.get('r1').row._rowClass, undefined);
    assert.equal(r.store.rowByKey.get('r1').row._cellClass, undefined);
});

if (failures.length > 0) {
    console.error(`\nclass-when: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nclass-when OK');
