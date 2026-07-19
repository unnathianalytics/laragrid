/**
 * Node harness: pins the F9 TEMPORARY ROW HIDE contract (display grids) and the
 * F8 row-delete remap — consumer feature requests, 2026-07-19.
 *
 * Pinned against the REAL StateStore + SHARED_KEYMAP:
 *   1. Keymap: F8 = row delete (F7 unbound — freed for host apps), Delete still clears,
 *      Shift+Delete still deletes; F9 = rowHide, Shift+F9 = rowRestore.
 *   2. hideRowLocally: removes the row from view into hiddenStash, captures the seed
 *      order, and localAggregate recomputes sum/count over the VISIBLE rows (sum skips
 *      the ''-empty convention) — the footer's what-if view.
 *   3. restoreHiddenRows: no sort → rows return in the captured seed order; active local
 *      sort → the restored set is re-sorted under it.
 *   4. Interplay: a sort-clear (third click) NEVER resurrects hidden rows and keeps the
 *      seed copy alive for the eventual restore; an external setRows() clears the stash
 *      and the sort state together.
 *   5. Gates: server-side and editable stores refuse hide/restore outright.
 *
 * Invoke directly: `node tests/js/run-hide-vectors.mjs` (also part of `npm test`).
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const mod = (p) => pathToFileURL(resolve(root, 'resources', 'js', ...p.split('/'))).href;

const { default: StateStore } = await import(mod('core/StateStore.js'));
const { default: EventBus } = await import(mod('core/EventBus.js'));
const { SHARED_KEYMAP } = await import(mod('keyboard/keys.js'));

let failures = 0;
const check = (name, cond, detail = '') => {
    if (cond) {
        console.log(`  ok    ${name}`);
    } else {
        failures++;
        console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    }
};
const keys = (store) => store.rows.map((r) => r._k).join(',');

/* -------------------------------------------------------------------- keymap */

console.log('keymap:');
check('F8 deletes the row', SHARED_KEYMAP.F8
    && SHARED_KEYMAP.F8.action === 'rowop' && SHARED_KEYMAP.F8.kind === 'delete');
check('F7 is unbound (freed for host apps)', SHARED_KEYMAP.F7 === undefined);
check('Delete still CLEARS (Excel contract)', SHARED_KEYMAP.Delete.kind === 'clear');
check('Shift+Delete still deletes', SHARED_KEYMAP['Shift+Delete'].kind === 'delete');
check('F9 hides', SHARED_KEYMAP.F9 && SHARED_KEYMAP.F9.action === 'rowHide');
check('Shift+F9 restores', SHARED_KEYMAP['Shift+F9']
    && SHARED_KEYMAP['Shift+F9'].action === 'rowRestore');

/* ------------------------------------------------------------------- fixture */

const rows = () => [
    { _k: 'a', account: 'Cash', debit: 125000 },
    { _k: 'b', account: 'Sales', debit: '' },
    { _k: 'c', account: 'Bank', debit: 99900 },
    { _k: 'd', account: 'Alpha', debit: 125000 },
    { _k: 'e', account: 'Freight', debit: 2000 },
];
const displayStore = () => new StateStore({
    name: 'h',
    columns: [{ key: 'account', sortable: true }, { key: 'debit', sortable: true }],
    footer: [{ column: 'debit', op: 'sum' }],
    layout: {},
    rows: rows(),
}, new EventBus());

/* -------------------------------------------------------- hide + what-if sum */

console.log('hide + footer recompute:');
const s = displayStore();
const sumAgg = { column: 'debit', op: 'sum' };
check('baseline visible sum (empties skipped)', s.localAggregate(sumAgg) === 351900);

check('hide removes the row from view', s.hideRowLocally('a') === true && keys(s) === 'b,c,d,e');
check('stash holds it', s.hiddenStash.size === 1 && s.hiddenStash.has('a'));
check('sum recomputes over visible rows', s.localAggregate(sumAgg) === 226900);
check('count tracks visible rows', s.localAggregate({ column: 'debit', op: 'count' }) === 4);

s.hideRowLocally('d');
check('second hide compounds', keys(s) === 'b,c,e' && s.localAggregate(sumAgg) === 101900);
check('hiding an unknown key is a no-op', s.hideRowLocally('ghost') === false);

/* ------------------------------------------------------------- restore order */

check('restore-all returns the seed order', s.restoreHiddenRows() === true && keys(s) === 'a,b,c,d,e');
check('stash empty + seed released', s.hiddenStash.size === 0 && s.localSeedRows === null);
check('restore with nothing hidden is a no-op', s.restoreHiddenRows() === false);

console.log('restore under an active sort:');
const s2 = displayStore();
s2.cycleSort('debit'); // asc: c,a,d,e then empty b last → c? (2000 e first) — assert explicitly:
check('asc pre-hide', keys(s2) === 'e,c,a,d,b', keys(s2));
s2.hideRowLocally('c');
check('hide under sort', keys(s2) === 'e,a,d,b');
s2.restoreHiddenRows();
check('restored set is re-sorted under the active sort', keys(s2) === 'e,c,a,d,b', keys(s2));
check('sort state survives the restore', s2.query.sort === 'debit' && s2.query.dir === 'asc');

/* -------------------------------------------------- sort-clear must not leak */

console.log('sort-clear interplay:');
const s3 = displayStore();
s3.hideRowLocally('b');
s3.cycleSort('debit'); // asc
s3.cycleSort('debit'); // desc
s3.cycleSort('debit'); // clear → seed order MINUS the hidden row
check('sort-clear does NOT resurrect the hidden row', keys(s3) === 'a,c,d,e', keys(s3));
check('seed copy kept while rows stay hidden', Array.isArray(s3.localSeedRows));
s3.restoreHiddenRows();
check('restore after sort-clear yields the full seed order', keys(s3) === 'a,b,c,d,e', keys(s3));

/* ------------------------------------------------------------ external reset */

const s4 = displayStore();
s4.hideRowLocally('a');
s4.setRows([{ _k: 'z', account: 'New', debit: 1 }]); // reseed
check('external setRows clears the stash + sort state',
    s4.hiddenStash.size === 0 && s4.localSeedRows === null && s4.query.sort === null);

/* -------------------------------------------------------------------- gates */

console.log('gates:');
const editable = new StateStore({
    name: 'e', columns: [{ key: 'n' }], layout: { editable: true },
    rows: [{ _k: 'x', n: 1 }],
}, new EventBus());
check('editable refuses hide', editable.hideRowLocally('x') === false);

const server = new StateStore({
    name: 's', columns: [{ key: 'n' }], layout: { serverSide: true },
    rows: [{ _k: 'x', n: 1 }],
}, new EventBus());
check('server-side refuses hide', server.hideRowLocally('x') === false);

/* ------------------------------------------------------------------ summary */

if (failures > 0) {
    console.error(`\nhide vectors: ${failures} assertion(s) FAILED`);
    process.exit(1);
}
console.log('\nhide vectors: all assertions passed');
