/**
 * Node harness: exercise the REAL ClipboardManager over a REAL StateStore + SelectionManager.
 * Pins the select-all copy header (Ctrl+A copies the column labels first, a plain range does not)
 * and the paste side that drops that header again, so an editable Ctrl+A copy still round-trips.
 * Invoked by tests/Feature/Grid/ClipboardVectorsTest.php via Symfony Process (skipped when node
 * is unavailable) and runnable directly: `node tests/js/run-clipboard-vectors.mjs`.
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');
const load = (rel) => import(pathToFileURL(resolve(jsBase, rel)).href);

const { default: StateStore } = await load('core/StateStore.js');
const { default: EventBus } = await load('core/EventBus.js');
const { default: SelectionManager } = await load('selection/SelectionManager.js');
const { default: ClipboardManager } = await load('clipboard/ClipboardManager.js');

const failures = [];
const check = (name, cond, detail = '') => {
    if (!cond) {
        failures.push(detail ? `${name}: ${detail}` : name);
    }
};

const LEDGER_COLUMNS = [
    { key: '_serial', label: '#', navigable: false },
    { key: 'account', label: 'Account' },
    { key: 'opening', label: 'Opening' },
    { key: 'opening_dc', label: '' },
    { key: 'debit', label: 'Debit' },
];

function rig({ columns = LEDGER_COLUMNS, groups = [], editable = false, rows } = {}) {
    const store = new StateStore({
        name: 'ledger',
        columns: columns.map((c) => ({ visible: true, editable, ...c })),
        groups,
        layout: { editable },
    }, new EventBus());
    store.setRows(rows || [
        { _k: 'a', _serial: 1, account: 'AVENUE COMPUTERS', opening: '0.00', opening_dc: 'Dr', debit: '23,388.00' },
        { _k: 'b', _serial: 2, account: 'COMPUTER HOUSE', opening: '0.00', opening_dc: 'Dr', debit: '13,004.00' },
    ]);
    const selection = new SelectionManager(store, {});
    const messages = [];
    const clipboard = new ClipboardManager(store, { announce: (m) => messages.push(m) });
    const written = [];
    clipboard.write = (text) => written.push(text);
    return { store, selection, clipboard, written, messages };
}

function pasteRig(opts) {
    const r = rig({ ...opts, editable: true });
    const pasted = [];
    const ctx = {
        editor: {
            pasteCell(rowKey, colKey, column, raw) {
                pasted.push(`${rowKey}.${colKey}=${raw}`);
                return { ok: true, op: { t: 'set' }, cells: [] };
            },
        },
        sync: { enqueueBatch() {} },
        popup: null,
    };
    r.store.setActive({ rowKey: 'a', colKey: 'account' });
    return { ...r, pasted, paste: (text) => r.clipboard.paste(text, ctx) };
}

// 1. Ctrl+A copies the header row first — blank labels keep their column, the gutter is skipped.
{
    const { selection, clipboard, written, messages } = rig();
    selection.selectAll();
    clipboard.copy();
    const expected = [
        'Account\tOpening\t\tDebit',
        'AVENUE COMPUTERS\t0.00\tDr\t23,388.00',
        'COMPUTER HOUSE\t0.00\tDr\t13,004.00',
    ].join('\n');
    check('all-copies-header', written[0] === expected, JSON.stringify(written[0]));
    check('all-announces-header', messages[0] === 'Copied 2 rows by 4 columns with headers.', messages[0]);
}

// 2. A plain range copy keeps the data-only TSV (no header) — even when it spans every cell.
{
    const { store, clipboard, written, messages } = rig();
    store.setActive({ rowKey: 'a', colKey: 'account' });
    store.setActive({ rowKey: 'b', colKey: 'debit' }, { keepAnchor: true, kind: 'range' });
    clipboard.copy();
    check('range-no-header', written[0] === 'AVENUE COMPUTERS\t0.00\tDr\t23,388.00\nCOMPUTER HOUSE\t0.00\tDr\t13,004.00',
        JSON.stringify(written[0]));
    check('range-announce', messages[0] === 'Copied 2 rows by 4 columns.', messages[0]);
}

// 3. Grouped headers copy as two rows: the group label sits on its first member only.
{
    const { selection, clipboard, written } = rig({
        groups: [{ label: 'Opening', columns: ['opening', 'opening_dc'] }],
        columns: LEDGER_COLUMNS.map((c) => (c.key === 'opening' ? { ...c, label: 'Amount' } : c)),
    });
    selection.selectAll();
    clipboard.copy();
    const lines = written[0].split('\n');
    check('group-row', lines[0] === '\tOpening\t\t', JSON.stringify(lines[0]));
    check('group-leaf-row', lines[1] === 'Account\tAmount\t\tDebit', JSON.stringify(lines[1]));
    check('group-data-follows', lines[2] === 'AVENUE COMPUTERS\t0.00\tDr\t23,388.00', JSON.stringify(lines[2]));
}

// 4. A label with a tab or newline stays ONE header field.
{
    const { selection, clipboard, written } = rig({
        columns: [{ key: 'account', label: 'Ledger\nAccount' }, { key: 'debit', label: 'Debit\tAmount' }],
        rows: [{ _k: 'a', account: 'Cash', debit: '1' }],
    });
    selection.selectAll();
    clipboard.copy();
    check('label-one-field', written[0] === 'Ledger Account\tDebit Amount\nCash\t1', JSON.stringify(written[0]));
}

// 5. Editable round trip: pasting a Ctrl+A copy drops the header and pastes the data only.
{
    const { selection, clipboard, written, store, pasted, paste } = pasteRig();
    selection.selectAll();
    clipboard.copy();
    store.setActive({ rowKey: 'a', colKey: 'account' });
    paste(written[0].replace(/\n/g, '\r\n') + '\r\n');
    check('roundtrip-header-dropped', !pasted.some((p) => p.includes('=Account')), pasted.join(' | '));
    check('roundtrip-first-row', pasted[0] === 'a.account=AVENUE COMPUTERS', pasted[0]);
    check('roundtrip-count', pasted.length === 8, String(pasted.length));
}

// 6. The header pasted from a spreadsheet range that stops before a trailing blank-label column.
{
    const { pasted, paste } = pasteRig({
        columns: [{ key: 'account', label: 'Account' }, { key: 'closing', label: 'Closing' }, { key: 'closing_dc', label: '' }],
        rows: [{ _k: 'a', account: '', closing: '', closing_dc: '' }],
    });
    paste('Account\tClosing\nCASH\t5');
    check('short-header-dropped', pasted.join(' | ') === 'a.account=CASH | a.closing=5', pasted.join(' | '));
}

// 7. A row that only PARTLY matches the labels is data, not a header.
{
    const { pasted, paste } = pasteRig();
    paste('Account\tOpening\tDr\tDebit');
    check('partial-match-kept', pasted[0] === 'a.account=Account' && pasted.length === 4, pasted.join(' | '));
}

// 8. Grouped header block is dropped as a whole on paste.
{
    const { pasted, paste } = pasteRig({ groups: [{ label: 'Opening', columns: ['opening', 'opening_dc'] }] });
    paste('\tOpening\t\t\nAccount\tOpening\t\tDebit\nCASH\t5\tDr\t7');
    check('group-header-dropped', pasted[0] === 'a.account=CASH' && pasted.length === 4, pasted.join(' | '));
}

// 9. Header alone pastes nothing.
{
    const { pasted, paste } = pasteRig();
    paste('Account\tOpening\t\tDebit\n');
    check('header-only-noop', pasted.length === 0, pasted.join(' | '));
}

if (failures.length) {
    console.error(`clipboard vectors FAILED (${failures.length}):\n  ${failures.join('\n  ')}`);
    process.exit(1);
}
console.log('clipboard vectors OK');
