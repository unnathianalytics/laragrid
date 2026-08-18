/**
 * Node harness for the editable auto-append zero-logical-row invariant. It exercises the real
 * GridCore delete command, StateStore structural mutation, KeyboardManager routing and
 * UndoManager replay without requiring a browser runner (this package has no Playwright/Dusk
 * setup). A tiny DOM surface is enough to pin focus ownership and empty-state visibility.
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);

const { default: GridCore } = await load('core/GridCore.js');
const { default: UndoManager } = await load('undo/UndoManager.js');
const { default: KeyboardManager } = await load('keyboard/KeyboardManager.js');

const originalDocument = globalThis.document;

function classList() {
    const classes = new Set();
    return {
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
        contains: (name) => classes.has(name),
    };
}

function rootRef() {
    const root = {
        classList: classList(),
        contains: (candidate) => candidate === root,
        focus: () => { globalThis.document.activeElement = root; },
    };
    return root;
}

function eventFor(key, opts = {}) {
    return {
        key,
        target: opts.target,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault() { this.prevented = true; },
        ...opts,
    };
}

function rig({ row, autoAppend = true, minRows = 0 } = {}) {
    const root = rootRef();
    globalThis.document = { activeElement: root };
    const config = {
        name: 'lines',
        columns: [
            { key: '_serial', visible: true, editable: false, writable: false, navigable: false },
            { key: 'name', visible: true, editable: true, writable: true, navigable: true },
            { key: 'qty', visible: true, editable: true, writable: true, navigable: true },
        ],
        layout: {
            editable: true,
            autoAppend,
            minRows,
            newRow: { name: null, qty: 1 },
        },
        rows: [row || { _k: 'only', name: 'Old line', qty: 2 }],
    };
    const core = new GridCore(config, { root });
    const flushed = [];
    const sync = {
        enqueue(op) { flushed.push([op]); },
        enqueueBatch(items) { flushed.push(items.map(({ op }) => op)); },
    };
    const undo = new UndoManager(core.store, sync, { announce: () => {} });
    core.store.recorder = undo;
    core.sync = sync;
    core.store.setActive({ rowKey: core.store.rows[0]._k, colKey: 'qty' });
    return { core, root, sync, undo, flushed };
}

function emptySurface(core) {
    const clone = { hidden: true, textContent: '' };
    const emptyTemplate = { content: { firstElementChild: { cloneNode: () => clone } } };
    core.refs.emptyTemplate = emptyTemplate;
    core.refs.body = { after: () => {} };
    core.renderEmptyState();
    const off = core.bus.on('rows:changed', () => core.renderEmptyState());
    return { clone, off };
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

await scenario('deleting the sole filled row atomically materializes one focused draft', () => {
    const { core, root, flushed } = rig();
    const rowCounts = [];
    core.bus.on('rows:changed', () => rowCounts.push(core.store.rowCount()));
    const empty = emptySurface(core);

    core.rowDelete();

    assert.equal(core.store.rowCount(), 1);
    assert.deepEqual(rowCounts, [1], 'the renderer never observes a zero-row intermediate state');
    assert.equal(core.store.rows[0].name, null);
    assert.equal(core.store.rows[0].qty, 1, 'the serialized new-row factory template is reused');
    assert.notEqual(core.store.rows[0]._k, 'only');
    assert.equal(core.store.rowByKey.get(core.store.rows[0]._k).row, core.store.rows[0]);
    assert.deepEqual(core.store.active, { rowKey: core.store.rows[0]._k, colKey: 'name' });
    assert.equal(globalThis.document.activeElement, root);
    assert.equal(root.classList.contains('lgrid--empty'), false);
    assert.equal(empty.clone.hidden, true);
    assert.deepEqual(flushed[0].map((op) => op.t), ['remove', 'insert']);
    assert.equal(flushed[0][0].row, 'only');
    assert.equal(flushed[0][1].as, core.store.rows[0]._k, 'wire and client share the draft key');
    empty.off();
});

await scenario('deleting the sole blank row replaces it with a freshly keyed blank', () => {
    const { core, flushed } = rig({ row: { _k: 'blank-old', name: null, qty: 1 } });
    core.rowDelete();

    assert.equal(core.store.rowCount(), 1);
    assert.notEqual(core.store.rows[0]._k, 'blank-old');
    assert.equal(core.store.rowIsBlankByKey(core.store.rows[0]._k), true);
    assert.deepEqual(flushed[0].map((op) => op.t), ['remove', 'insert']);
});

await scenario('Shift+Delete and F9 route through the identical replacement command', () => {
    for (const gesture of [
        { key: 'Delete', shiftKey: true },
        { key: 'F9' },
    ]) {
        const { core, root, flushed } = rig();
        const editorOpens = [];
        const keyboard = new KeyboardManager(core.store, {}, { root }, {
            editor: { isEditing: () => false, open: (opts) => editorOpens.push(opts) },
            rowOps: { delete: () => core.rowDelete() },
            rowRemove: () => core.rowDelete(),
        });

        const deletion = eventFor(gesture.key, { target: root, shiftKey: !!gesture.shiftKey });
        keyboard.handleKeyDown(deletion);
        assert.equal(deletion.prevented, true);
        assert.equal(core.store.rowCount(), 1);
        assert.deepEqual(flushed[0].map((op) => op.t), ['remove', 'insert']);

        const typing = eventFor('N', { target: root });
        keyboard.handleKeyDown(typing);
        assert.deepEqual(editorOpens, [{ seed: 'N' }], 'typing can immediately reopen EDIT mode');
    }
});

await scenario('undo restores the deleted row and redo returns to one draft', () => {
    const { core, undo, flushed } = rig();
    core.rowDelete();
    const draftKey = core.store.rows[0]._k;

    assert.equal(undo.undo(), true);
    assert.deepEqual(core.store.rows.map((row) => row._k), ['only']);
    assert.equal(core.store.rows[0].name, 'Old line');
    assert.equal(core.store.rowByKey.has(draftKey), false, 'undo does not retain a duplicate draft');
    assert.deepEqual(flushed[1].slice(0, 2).map((op) => op.t), ['remove', 'insert']);
    assert.deepEqual(flushed[1].slice(2).map((op) => op.col), ['name', 'qty']);

    assert.equal(undo.redo(), true);
    assert.deepEqual(core.store.rows.map((row) => row._k), [draftKey]);
    assert.equal(core.store.rowIsBlankByKey(draftKey), true);
    assert.deepEqual(flushed[2].map((op) => op.t), ['remove', 'insert', 'set']);
    assert.equal(flushed[2][2].col, 'qty');
});

await scenario('minRows(1) still refuses deletion before any replacement or sync', () => {
    const { core, flushed } = rig({ minRows: 1 });
    core.rowDelete();
    assert.deepEqual(core.store.rows.map((row) => row._k), ['only']);
    assert.equal(flushed.length, 0);
});

await scenario('non-auto-append and readonly zero-row surfaces retain their empty state', () => {
    const { core } = rig({ autoAppend: false });
    const editableEmpty = emptySurface(core);
    core.rowDelete();
    assert.equal(core.store.rowCount(), 0);
    assert.equal(core.refs.root.classList.contains('lgrid--empty'), true);
    assert.equal(editableEmpty.clone.hidden, false);
    editableEmpty.off();

    const readonlyRoot = rootRef();
    const readonly = new GridCore({
        name: 'read',
        columns: [{ key: 'name', visible: true, navigable: true }],
        layout: { editable: false, autoAppend: false },
        rows: [],
    }, { root: readonlyRoot });
    const readonlyEmpty = emptySurface(readonly);
    assert.equal(readonlyRoot.classList.contains('lgrid--empty'), true);
    assert.equal(readonlyEmpty.clone.hidden, false);
    readonlyEmpty.off();
});

globalThis.document = originalDocument;

if (failures.length > 0) {
    console.error(`\nzero-row vectors: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\nzero-row vectors OK');
