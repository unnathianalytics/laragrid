/**
 * Node harness: pins the LOCAL SORT contract for in-memory display grids — the fix for
 * "sorting is dead on display grids" (inert button: HeaderRenderer drew the control from
 * column.sortable alone while GridCore only bound the handler for serverSide grids).
 *
 * Pinned here, against the REAL StateStore:
 *   1. compareCellValues: numbers (and cleanly numeric strings) compare numerically,
 *      strings via localeCompare — raw paise never sort lexically.
 *   2. sortRowsLocally: STABLE (equal keys keep order; asc ↔ desc lossless), and empties
 *      (null/undefined/'') rank LAST in BOTH directions (Trial Balance ships '' for a
 *      zero side — it must never sort as 0).
 *   3. cycleSort: asc → desc → CLEAR restores the untouched seed order; query.sort/dir
 *      track every step (the header indicators read them).
 *   4. Gates: canSort is true for display + server-side grids, false for editable;
 *      cycleSort no-ops on editable and server-side stores.
 *   5. An external setRows() (reseed) drops the seed copy and clears the sort state.
 *   6. Footer configuration is untouched by sorting (order-independent by construction).
 *
 * Comparator sign vectors live in tests/fixtures/grid-vectors/sort.json (locale-safe).
 * Invoke directly: `node tests/js/run-sort-vectors.mjs` (also part of `npm test`).
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const { default: StateStore, compareCellValues } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'core', 'StateStore.js')).href
);
const { default: EventBus } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'core', 'EventBus.js')).href
);

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

/* -------------------------------------------------- comparator sign vectors */

const vectors = JSON.parse(
    readFileSync(resolve(root, 'tests', 'fixtures', 'grid-vectors', 'sort.json'), 'utf8'),
);

console.log('comparator vectors:');
for (const v of vectors.comparator) {
    const got = Math.sign(compareCellValues(v.a, v.b));
    check(
        `${JSON.stringify(v.a)} vs ${JSON.stringify(v.b)} → ${v.expect}`,
        got === v.expect,
        `got ${got}${v.note ? ' (' + v.note + ')' : ''}`,
    );
}

/* ------------------------------------------------------------- store fixture */

const rows = () => [
    { _k: 'a', account: 'Cash', debit: 125000, credit: '' },
    { _k: 'b', account: 'Sales', debit: '', credit: 50000 },
    { _k: 'c', account: 'Bank', debit: 99900, credit: '' },
    { _k: 'd', account: 'Alpha', debit: 125000, credit: '' }, // = a's debit: stability probe
    { _k: 'e', account: 'Freight', debit: '', credit: 2000 },
];
const displayStore = () => new StateStore({
    name: 't',
    columns: [{ key: 'account' }, { key: 'debit' }, { key: 'credit' }],
    layout: {},
    rows: rows(),
}, new EventBus());

/* --------------------------------------------------------- cycle + stability */

console.log('local sort cycle (numeric column, empties, stability):');
const s = displayStore();
check('seed order', keys(s) === 'a,b,c,d,e');

s.cycleSort('debit'); // asc
check('asc: numeric order, equal keys keep seed order, empties LAST',
    keys(s) === 'c,a,d,b,e', keys(s));
check('asc: query tracks sort/dir', s.query.sort === 'debit' && s.query.dir === 'asc');

s.cycleSort('debit'); // desc
check('desc: reversed non-empties, stability preserved, empties STILL last',
    keys(s) === 'a,d,c,b,e', keys(s));
check('desc: query tracks dir', s.query.dir === 'desc');

s.cycleSort('debit'); // clear
check('third click restores the untouched seed order', keys(s) === 'a,b,c,d,e', keys(s));
check('clear: query.sort null', s.query.sort === null && s.query.dir === 'asc');

s.cycleSort('debit'); // asc again — lossless round trip
check('post-cycle asc is identical (lossless)', keys(s) === 'c,a,d,b,e', keys(s));

console.log('string column:');
const s2 = displayStore();
s2.cycleSort('account');
check('asc: localeCompare order', keys(s2) === 'd,c,a,e,b', keys(s2));

/* ------------------------------------------------------------------- gates */

console.log('gates:');
check('display grid canSort', displayStore().canSort === true);

const editable = new StateStore({
    name: 'e', columns: [{ key: 'n' }], layout: { editable: true },
    rows: [{ _k: 'x', n: 2 }, { _k: 'y', n: 1 }],
}, new EventBus());
check('editable grid canSort=false', editable.canSort === false);
editable.cycleSort('n');
check('editable cycleSort is a no-op', editable.rows.map((r) => r._k).join(',') === 'x,y');

const server = new StateStore({
    name: 's', columns: [{ key: 'n' }], layout: { serverSide: true },
    rows: [{ _k: 'x', n: 2 }, { _k: 'y', n: 1 }],
}, new EventBus());
check('server-side grid canSort=true (PageSource path)', server.canSort === true);
server.cycleSort('n');
check('server-side cycleSort is a no-op (PageSource owns it)',
    server.rows.map((r) => r._k).join(',') === 'x,y');

/* ------------------------------------------- reseed reset + selection clear */

console.log('reseed + selection:');
const s3 = displayStore();
s3.cycleSort('debit');
s3.setRows([{ _k: 'z', account: 'New', debit: 1, credit: '' }]); // external reseed
check('external setRows clears sort state', s3.query.sort === null && s3.localSeedRows === null);

const s4 = displayStore();
s4.active = { rowKey: 'a', colKey: 'debit' };
s4.anchor = { rowKey: 'a', colKey: 'debit' };
s4.selection = { r0: 0, r1: 2, c0: 0, c1: 1, kind: 'range' };
s4.cycleSort('debit');
check('sort clears the index-space selection rectangle', s4.selection === null);
check('active cell (stable rowKey) survives the reorder',
    s4.active && s4.active.rowKey === 'a');

/* ------------------------------------------------- footer order-independence */

const s5 = new StateStore({
    name: 'f',
    columns: [{ key: 'account' }, { key: 'debit' }],
    footer: [{ column: 'debit', op: 'sum' }],
    layout: {},
    rows: rows(),
}, new EventBus());
const footerBefore = JSON.stringify(s5.footer);
s5.cycleSort('debit');
check('footer configuration untouched by sorting', JSON.stringify(s5.footer) === footerBefore);

/* ----------------------------------------------- defaultSort at construction */

console.log('defaultSort at init (in-memory grids):');
const sortableCols = [
    { key: 'account', sortable: true },
    { key: 'debit', sortable: true },
    { key: 'group' }, // deliberately NOT sortable
];
const withDefault = (layout) => new StateStore({
    name: 'ds', columns: sortableCols, layout, rows: rows(),
}, new EventBus());

// 1. asc applied to the ROWS at construction — not just to query.sort.
const d1 = withDefault({ defaultSort: { col: 'account', dir: 'asc' } });
check('defaultSort asc: rows sorted at construction', keys(d1) === 'd,c,a,e,b', keys(d1));
check('defaultSort asc: query describes the applied order',
    d1.query.sort === 'account' && d1.query.dir === 'asc');

// 2. desc variant.
const d2 = withDefault({ defaultSort: { col: 'account', dir: 'desc' } });
check('defaultSort desc: rows sorted at construction', keys(d2) === 'b,e,a,c,d', keys(d2));

// 3+4. Cycle from the applied default: desc → restore HOST seed (NOT the defaultSort) → asc.
d1.cycleSort('account');
check('first click after default-asc lands on DESC (no double-asc)', keys(d1) === 'b,e,a,c,d', keys(d1));
d1.cycleSort('account');
check('second click restores the HOST seed order, not the defaultSort order',
    keys(d1) === 'a,b,c,d,e', keys(d1));
check('second click clears query.sort', d1.query.sort === null);
d1.cycleSort('account');
check('third click reaches ascending', keys(d1) === 'd,c,a,e,b', keys(d1));

// 5. Non-sortable defaultSort column: rows untouched AND no lying indicator state
//    (assertValid refuses this server-side; the client skip is the defensive twin).
const d5 = withDefault({ defaultSort: { col: 'group', dir: 'asc' } });
check('non-sortable defaultSort: rows untouched', keys(d5) === 'a,b,c,d,e', keys(d5));
check('non-sortable defaultSort: query.sort cleared (caret cannot lie)', d5.query.sort === null);

// 6. Editable grid: defaultSort is inert by mode — no reorder, no claimed state.
const d6 = withDefault({ editable: true, defaultSort: { col: 'account', dir: 'asc' } });
check('editable + defaultSort: rows untouched', keys(d6) === 'a,b,c,d,e', keys(d6));
check('editable + defaultSort: query.sort cleared', d6.query.sort === null);

// 7. Regression: server-side construction is untouched — SQL carries the order, the
//    seeded query merely DESCRIBES it, and no local sort runs.
const d7 = withDefault({ serverSide: true, defaultSort: { col: 'account', dir: 'asc' } });
check('server-side: rows stay in payload order (no local sort at init)',
    keys(d7) === 'a,b,c,d,e', keys(d7));
check('server-side: query.sort still seeded from defaultSort (describes the SQL order)',
    d7.query.sort === 'account' && d7.query.dir === 'asc');
check('server-side: no seed copy captured', d7.localSeedRows === null);

/* ------------------------------------------------------------------ summary */

if (failures > 0) {
    console.error(`\nsort vectors: ${failures} assertion(s) FAILED`);
    process.exit(1);
}
console.log('\nsort vectors: all assertions passed');
