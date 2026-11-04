/**
 * Node harness: pins paste by label into server-mode pickers (plan F3) on the REAL StateStore,
 * EditorManager, ClipboardManager, UndoManager, SyncManager and DraftStore.
 *
 *   1. pasteCell on a server-mode picker stages a `lookup` op carrying the trimmed text and no
 *      label, paints the text as a provisional label, and tracks the cell in store.lookups; a
 *      client-mode picker keeps its option-list mapping.
 *   2. A paste announces how many cells went to the server for a lookup; an id the column
 *      already holds (a copy from the grid itself) is staged as that id with its label.
 *   3. The resolved answer to the newest lookup clears it and adopts the id and label; an older
 *      answer does not clear a newer lookup; a refused lookup stays tracked (a reload resolves
 *      it again); a later plain write supersedes the lookup.
 *   4. Undo of a lookup paste replays the replaced value without `lookup`; redo replays the
 *      label with `lookup` and without a `label` field.
 *   5. The draft snapshot carries `lookups` only while one is pending, and the restore request
 *      forwards them to gridRestoreDraft.
 *
 * Invoke directly: `node tests/js/run-paste-lookup.mjs` (also part of `npm test`).
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);

const { default: EventBus } = await load('core/EventBus.js');
const { default: StateStore } = await load('core/StateStore.js');
const { default: EditorManager } = await load('edit/EditorManager.js');
const { default: ClipboardManager } = await load('clipboard/ClipboardManager.js');
const { default: UndoManager } = await load('undo/UndoManager.js');
const { default: SyncManager } = await load('sync/SyncManager.js');
const { default: DraftStore } = await load('persist/DraftStore.js');
const { default: ClientValidator } = await load('validate/ClientValidator.js');
const { cellMapKey } = await load('util/dom.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const COLUMNS = [
    { key: 'account_id', label: 'Account', visible: true, editable: true, writable: true, navigable: true, parse: { kind: 'select' }, optionsMode: 'server', options: [] },
    { key: 'dc', label: 'D/C', visible: true, editable: true, writable: true, navigable: true, parse: { kind: 'select' }, optionsMode: 'client', options: [{ value: 'D', label: 'Dr' }, { value: 'C', label: 'Cr' }] },
    { key: 'memo', label: 'Memo', visible: true, editable: true, writable: true, navigable: true, parse: { kind: 'text' } },
];

function rig() {
    const bus = new EventBus();
    const store = new StateStore({
        name: 'lines',
        columns: COLUMNS,
        rows: [
            { _k: 'r1', account_id: 'old', dc: 'D', memo: '', _labels: { account_id: 'Old Account' } },
            { _k: 'r2', account_id: null, dc: 'D', memo: '' },
        ],
        layout: { editable: true },
    }, bus);
    const batches = [];
    const sync = { enqueue(op, cells) { batches.push([{ op, cells }]); }, enqueueBatch(items) { batches.push(items); } };
    const editor = new EditorManager(store, null, null, sync, new ClientValidator(), bus, {});
    const messages = [];
    const clipboard = new ClipboardManager(store, { announce: (m) => messages.push(m) });
    const undo = new UndoManager(store, sync, { announce() {} });
    store.recorder = undo;
    const ack = (op, patch = {}, errors = {}) => {
        store.reconcile({ version: op.seq, results: [{ seq: op.seq, ok: Object.keys(errors).length === 0, patch, errors }] }, [{ op, cells: [{ rowKey: op.row, colKey: op.col }] }]);
    };
    return { bus, store, sync, editor, clipboard, undo, batches, messages, ack };
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

await scenario('a server-mode picker paste stages a lookup op and a provisional label', () => {
    const r = rig();
    const result = r.editor.pasteCell('r2', 'account_id', COLUMNS[0], '  Cement 50kg ');
    assert.equal(result.ok, true);
    assert.equal(result.lookup, true);
    assert.deepEqual(
        { t: result.op.t, row: result.op.row, col: result.op.col, v: result.op.v, lookup: result.op.lookup },
        { t: 'set', row: 'r2', col: 'account_id', v: 'Cement 50kg', lookup: true },
    );
    assert.equal('label' in result.op, false, 'a lookup op never sends a label');
    const row = r.store.rowByKey.get('r2').row;
    assert.equal(row.account_id, 'Cement 50kg', 'the pasted text is the provisional value');
    assert.equal(row._labels.account_id, 'Cement 50kg', 'and the provisional label');
    assert.equal(r.store.lookups.get(cellMapKey('r2', 'account_id')), result.op.seq);

    const blank = r.editor.pasteCell('r2', 'account_id', COLUMNS[0], '   ');
    assert.equal(blank.lookup, undefined, 'a blank paste clears without a lookup');
    assert.equal(r.store.lookups.size, 0, 'and supersedes the earlier lookup');

    const client = r.editor.pasteCell('r2', 'dc', COLUMNS[1], 'cr');
    assert.equal(client.op.v, 'C', 'a client-mode picker maps the label locally');
    assert.equal(client.op.label, 'Cr');
    assert.equal(client.op.lookup, undefined);
});

await scenario('an id the column already holds is staged as that id, not looked up', () => {
    const r = rig();
    const result = r.editor.pasteCell('r2', 'account_id', COLUMNS[0], ' old ');
    assert.equal(result.lookup, undefined);
    assert.deepEqual({ v: result.op.v, label: result.op.label, lookup: result.op.lookup }, { v: 'old', label: 'Old Account', lookup: undefined });
    assert.equal(r.store.rowByKey.get('r2').row._labels.account_id, 'Old Account');
    assert.equal(r.store.lookups.size, 0);

    // A row holding unresolved pasted text never vouches for an id.
    r.editor.pasteCell('r1', 'account_id', COLUMNS[0], 'Cement 50kg');
    const second = r.editor.pasteCell('r2', 'account_id', COLUMNS[0], 'Cement 50kg');
    assert.equal(second.op.lookup, true);
});

await scenario('a paste announces the cells looked up on the server', () => {
    const r = rig();
    r.store.setActive({ rowKey: 'r1', colKey: 'account_id' });
    r.clipboard.paste('Cement 50kg\tC\tnote\nSand\tD\t', { editor: r.editor, sync: r.sync, popup: null });
    assert.equal(r.messages.at(-1), 'Pasted 6 cells, 2 looked up on the server.');
    const ops = r.batches.at(-1).map((item) => item.op);
    assert.deepEqual(ops.filter((op) => op.lookup).map((op) => `${op.row}=${op.v}`), ['r1=Cement 50kg', 'r2=Sand']);
    assert.equal(r.store.lookups.size, 2);

    r.store.setActive({ rowKey: 'r1', colKey: 'memo' });
    r.clipboard.paste('plain', { editor: r.editor, sync: r.sync, popup: null });
    assert.equal(r.messages.at(-1), 'Pasted 1 cell.', 'no lookup, no suffix');
});

await scenario('the answer to the newest lookup clears it and adopts the resolved id', () => {
    const r = rig();
    const first = r.editor.pasteCell('r2', 'account_id', COLUMNS[0], 'Cemnt').op;
    const second = r.editor.pasteCell('r2', 'account_id', COLUMNS[0], 'Cement 50kg').op;
    r.store.markPendingBatch([{ cells: [{ rowKey: 'r2', colKey: 'account_id' }], seq: first.seq }, { cells: [{ rowKey: 'r2', colKey: 'account_id' }], seq: second.seq }]);

    r.ack(first, {}, { r2: { account_id: 'No option matches "Cemnt".' } });
    assert.equal(r.store.lookups.get(cellMapKey('r2', 'account_id')), second.seq, 'an older answer keeps the newer lookup');

    r.ack(second, { r2: { account_id: 'a1', _labels: { account_id: 'Cement 50kg' }, rate: '350.00' } });
    assert.equal(r.store.lookups.size, 0);
    const row = r.store.rowByKey.get('r2').row;
    assert.equal(row.account_id, 'a1');
    assert.equal(row._labels.account_id, 'Cement 50kg');

    const refused = r.editor.pasteCell('r1', 'account_id', COLUMNS[0], 'Sand').op;
    r.store.markPending([{ rowKey: 'r1', colKey: 'account_id' }], refused.seq);
    r.ack(refused, {}, { r1: { account_id: '"Sand" matches 2 options; pick it from the list.' } });
    assert.equal(r.store.lookups.get(cellMapKey('r1', 'account_id')), refused.seq, 'a refused lookup stays tracked');
    r.editor.commitCell('r1', 'account_id', COLUMNS[0], { parsed: 'a3', wireValue: 'a3', label: 'Sand' });
    assert.equal(r.store.lookups.size, 0, 'a picked value supersedes the refused lookup');
});

await scenario('undo replays the replaced id without lookup; redo resolves the label again', async () => {
    const r = rig();
    r.editor.pasteCell('r1', 'account_id', COLUMNS[0], 'Cement 50kg');
    await tick();
    r.batches.length = 0;

    r.undo.undo();
    const undone = r.batches.at(-1).map((item) => item.op);
    assert.equal(undone.length, 1);
    assert.deepEqual({ v: undone[0].v, label: undone[0].label, lookup: undone[0].lookup }, { v: 'old', label: 'Old Account', lookup: undefined });
    assert.equal(r.store.lookups.size, 0, 'undo leaves nothing to resolve');
    assert.equal(r.store.rowByKey.get('r1').row._labels.account_id, 'Old Account');

    r.undo.redo();
    const redone = r.batches.at(-1).map((item) => item.op);
    assert.deepEqual({ v: redone[0].v, lookup: redone[0].lookup }, { v: 'Cement 50kg', lookup: true });
    assert.equal('label' in redone[0], false, 'the provisional label is not sent');
    assert.equal(r.store.lookups.get(cellMapKey('r1', 'account_id')), redone[0].seq);
});

await scenario('the draft carries lookups only while pending and the restore forwards them', async () => {
    const records = new Map();
    const backend = {
        async get(key) { return records.get(key) || null; },
        async put(key, value) { records.set(key, value); },
        async delete(key) { records.delete(key); },
    };
    const restores = [];
    const wire = {
        gridOps: async () => new Promise(() => {}), // never answers: the lookup stays pending
        gridRestoreDraft: async (_name, payload) => {
            restores.push(payload);
            return { version: 1, footer: {}, results: [], rows: payload.rows };
        },
    };
    const make = async () => {
        const bus = new EventBus();
        const store = new StateStore({ name: 'lines', columns: COLUMNS, rows: [{ _k: 'r1', account_id: null, dc: 'D', memo: '' }], layout: { editable: true, sync: 'deferred' } }, bus);
        const sync = new SyncManager(store, bus, wire);
        const target = () => ({ hidden: true, textContent: '', addEventListener() {}, removeEventListener() {} });
        const refs = { draftBar: target(), draftMessage: target(), draftRestore: target(), draftDiscard: target() };
        const draft = new DraftStore({ mode: 'local', key: 'tenant:lines' }, store, sync, bus, refs, { backend, debounceMs: 1 });
        await draft.init();
        const editor = new EditorManager(store, null, null, sync, new ClientValidator(), bus, {});
        return { store, sync, draft, editor };
    };

    const first = await make();
    assert.equal('lookups' in first.draft.snapshot(), false, 'no lookup, no key');
    const staged = first.editor.pasteCell('r1', 'account_id', COLUMNS[0], 'Cement 50kg');
    first.sync.enqueue(staged.op, staged.cells);
    const key = cellMapKey('r1', 'account_id');
    assert.deepEqual(first.draft.snapshot().lookups, [key]);
    await first.draft.saveNow();
    assert.deepEqual(records.get('lgrid:draft:tenant:lines').lookups, [key], 'the stored draft carries the lookup');
    first.draft.destroy();
    first.sync.destroy();

    const second = await make();
    assert.equal(await second.draft.restoreCandidate(), true);
    assert.deepEqual(restores.at(-1).lookups, [key], 'gridRestoreDraft receives the lookups');
    assert.equal(second.store.lookups.size, 0, 'the restored rows are server-resolved');
    second.draft.destroy();
    second.sync.destroy();
});

if (failures.length > 0) {
    console.error(`\npaste-lookup: ${failures.length} scenario(s) FAILED`);
    process.exit(1);
}
console.log('\npaste-lookup OK');
