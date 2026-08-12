/**
 * Node harness: pins the F9 TEMPORARY ROW HIDE contract (display grids) and the
 * mode-aware F9 row removal and F7 repeat remap.
 *
 * Pinned against the REAL StateStore + SHARED_KEYMAP:
 *   1. Keymap: F7 repeats above, F8 is unbound, Delete still clears,
 *      Shift+Delete still deletes; F9 = rowRemove, Shift+F9 = rowRestore.
 *   2. hideRowLocally: removes the row from view into hiddenStash, captures the seed
 *      order, and localAggregate recomputes sum/count over the VISIBLE rows (sum skips
 *      the ''-empty convention) — the footer's what-if view.
 *   3. restoreHiddenRows: no sort → rows return in the captured seed order; active local
 *      sort → the restored set is re-sorted under it.
 *   4. Interplay: a sort-clear (third click) NEVER resurrects hidden rows and keeps the
 *      seed copy alive for the eventual restore; an external setRows() clears the stash
 *      and the sort state together.
 *   5. Gates: editable stores refuse hide/restore; server-side display rows can be hidden
 *      until their page data is refreshed.
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
const { default: PageSource } = await import(mod('sync/PageSource.js'));
const { default: SelectionManager } = await import(mod('selection/SelectionManager.js'));
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
check('F7 repeats the row above', SHARED_KEYMAP.F7
    && SHARED_KEYMAP.F7.action === 'rowop' && SHARED_KEYMAP.F7.kind === 'repeatAbove');
check('F8 is unbound', SHARED_KEYMAP.F8 === undefined);
check('Delete still CLEARS (Excel contract)', SHARED_KEYMAP.Delete.kind === 'clear');
check('Shift+Delete still deletes', SHARED_KEYMAP['Shift+Delete'].kind === 'delete');
check('F9 performs the mode-aware row removal', SHARED_KEYMAP.F9
    && SHARED_KEYMAP.F9.action === 'rowRemove');
check('Shift+F9 restores', SHARED_KEYMAP['Shift+F9']
    && SHARED_KEYMAP['Shift+F9'].action === 'rowRestore');

/* --------------------------------------------------------- click focus return */

console.log('focus return:');
let rootFocused = false;
let selectedAddress = null;
const fakeRow = { dataset: { k: 'row-2' } };
const fakeCell = {
    dataset: { c: 'name' },
    closest: (selector) => selector === '.lgrid-row' ? fakeRow : null,
};
const fakeTarget = {
    closest: (selector) => selector === '.lgrid-cell' ? fakeCell : null,
};
const focusSelection = new SelectionManager({
    visibleColumns: () => [{ key: 'name', navigable: true }],
    active: null,
    setActive: (address) => { selectedAddress = address; },
}, {
    root: { focus: () => { rootFocused = true; } },
    body: { contains: () => true },
    head: { contains: () => false },
});
focusSelection.handlePointerDown({ target: fakeTarget, shiftKey: false, button: 1 });
check('clicking a grid cell returns keyboard focus to the grid root', rootFocused === true);
check('focus return still activates the clicked cell',
    selectedAddress && selectedAddress.rowKey === 'row-2' && selectedAddress.colKey === 'name');

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

console.log('repeat row primitive:');
const repeated = displayStore();
const clone = repeated.dupRow('a', 'copy-a');
check('duplicate is inserted immediately after its source', keys(repeated) === 'a,copy-a,b,c,d,e');
check('duplicate carries the source values under a fresh key',
    clone && clone._k === 'copy-a' && clone.account === 'Cash' && clone.debit === 125000);

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
check('server-side display grids can hide the current-page row',
    server.hideRowLocally('x') === true && server.rows.length === 0);

/* --------------------------------------------- deferred initial (store flag) */

console.log('deferred initial payload (adaptive single-page):');
const dstore = new StateStore({
    name: 'd', columns: [{ key: 'n' }], layout: { serverSide: true }, rows: [],
    server: { deferred: true, total: 7300, page: 1, perPage: 7300, lastPage: 1 },
}, new EventBus());
check('server.deferred → deferredInitial true', dstore.deferredInitial === true);
check('deferred mount ships zero rows', dstore.rows.length === 0);
dstore.setPage(
    { rows: [{ _k: 'x', n: 1 }], total: 7300, page: 1, perPage: 100, lastPage: 73 },
    { ...dstore.query },
);
check('first page clears the deferral', dstore.deferredInitial === false && dstore.rows.length === 1);
check('inline stores default to deferredInitial=false', displayStore().deferredInitial === false);

// PageSource on a deferred mount must NOT seed its cache from the (deliberately empty)
// store: the seed sits under the current query's signature, so the boot-time load() of
// that same query becomes a cache hit — the empty page is applied, the deferral ends,
// and the real page-1 fetch never fires (the 4k-items empty-grid regression).
const dstore2 = new StateStore({
    name: 'd2', columns: [{ key: 'n' }], layout: { serverSide: true }, rows: [],
    server: { deferred: true, total: 4200, page: 1, perPage: 4200, lastPage: 1 },
}, new EventBus());
const fetched = [];
const wireStub = {
    gridFetch: (name, query) => {
        fetched.push(query);
        return Promise.resolve({
            rows: [{ _k: 'a', n: 1 }], total: 4200, page: 1, perPage: 4200,
            lastPage: 1, pageTotals: {}, grandTotals: {},
        });
    },
};
const source = new PageSource(dstore2, new EventBus(), wireStub);
source.load({ ...dstore2.query });
await new Promise((r) => setTimeout(r, 0)); // let the stubbed RPC promise settle
check('deferred mount: boot load() actually fetches (no empty cache hit)', fetched.length >= 1);
check('deferred mount: fetched page lands in the store', dstore2.rows.length === 1);
source.destroy();

// A deferred boot fetch that REJECTS (the wire:navigate race: the observer scans the
// swapped-in mount before Livewire initializes the component, so the call-time $wire
// lookup fails) must retry until the first page lands — never strand the empty grid.
const dstore3 = new StateStore({
    name: 'd3', columns: [{ key: 'n' }], layout: { serverSide: true }, rows: [],
    server: { deferred: true, total: 1100, page: 1, perPage: 1100, lastPage: 1 },
}, new EventBus());
let flakyCalls = 0;
const flakyWire = {
    gridFetch: () => {
        flakyCalls++;
        if (flakyCalls <= 2) {
            return Promise.reject(new Error('LaraGrid: could not resolve a Livewire $wire'));
        }
        return Promise.resolve({
            rows: [{ _k: 'a', n: 1 }], total: 1100, page: 1, perPage: 1100,
            lastPage: 1, pageTotals: {}, grandTotals: {},
        });
    },
};
const flakyBus = new EventBus();
let terminalErrors = 0;
flakyBus.on('fetch:error', () => terminalErrors++);
const flakySource = new PageSource(dstore3, flakyBus, flakyWire, { deferredRetryDelay: 5 });
flakySource.load({ ...dstore3.query });
await new Promise((r) => setTimeout(r, 100)); // 2 retries at 5/10ms + settle
check('deferred boot: rejected fetch retries until it lands', flakyCalls === 3 && dstore3.rows.length === 1);
check('deferred boot: no terminal fetch:error while retrying to success', terminalErrors === 0);
check('deferred boot: deferral over after the retried page', dstore3.deferredInitial === false);
flakySource.destroy();

// The non-deferred seed behaviour is unchanged: same-query load() stays a cache hit.
const istore = new StateStore({
    name: 'i', columns: [{ key: 'n' }], layout: { serverSide: true },
    rows: [{ _k: 'r1', n: 1 }],
    server: { total: 1, page: 1, perPage: 100, lastPage: 1 },
}, new EventBus());
const inlineFetches = [];
const inlineSource = new PageSource(istore, new EventBus(), {
    gridFetch: (name, query) => {
        inlineFetches.push(query);
        return Promise.resolve(null);
    },
});
inlineSource.load({ ...istore.query });
check('inline mount: same-query load() is still a cache hit (no fetch)', inlineFetches.length === 0);
inlineSource.destroy();

/* ------------------------------------------------------------------ summary */

if (failures > 0) {
    console.error(`\nhide vectors: ${failures} assertion(s) FAILED`);
    process.exit(1);
}
console.log('\nhide vectors: all assertions passed');
