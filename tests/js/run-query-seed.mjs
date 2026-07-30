/**
 * Node harness: pins the CLIENT half of ->persistQuery() — StateStore adopting the server's
 * `config.query` as the query it is already displaying.
 *
 * The server builds page 1 from the operator's session-persisted search/filters/sort/per-page,
 * so by the time the client boots, the rows on screen are ALREADY narrowed. If the store still
 * seeded itself from layout.defaultSort, three things would break at once: the header caret and
 * the funnels would describe a query nobody ran, the toolbar controls would paint blank over
 * filtered rows, and PageSource's cache seed would file that page under the WRONG signature —
 * so paging away and back would refetch instead of hitting the seed.
 *
 * Pinned here, against the REAL StateStore + PageSource:
 *   1. No config.query (every grid that does not persist) → today's behaviour, byte for byte.
 *   2. config.query present → sort/dir/search/filters all adopted.
 *   3. A partial/empty config.query never resurrects defaults it did not carry.
 *   4. dir is normalised (only 'desc' means desc) — a junk value cannot invert an order.
 *   5. The filters object is COPIED, not aliased — mutating store.query.filters must not write
 *      back into the config the page was rendered from.
 *   6. PageSource's seed signature equals the signature of the restored query.
 *
 * Invoke directly: `node tests/js/run-query-seed.mjs` (also part of `npm test`).
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const { default: StateStore } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'core', 'StateStore.js')).href
);
const { default: EventBus } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'core', 'EventBus.js')).href
);
const { default: PageSource } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'sync', 'PageSource.js')).href
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

const COLUMNS = [
    { key: 'name', label: 'Name' },
    { key: 'qty', label: 'Qty' },
];

/** A server-side config, optionally carrying the restored query. */
const configWith = (query) => {
    const config = {
        name: 'items',
        columns: COLUMNS,
        layout: {
            serverSide: true,
            defaultSort: { col: 'name', dir: 'asc' },
            paginate: { perPage: 25, options: [25, 50] },
        },
        server: { total: 3, page: 1, perPage: 25, lastPage: 1 },
        rows: [],
    };
    if (query !== undefined) {
        config.query = query;
    }
    return config;
};

const storeWith = (query) => new StateStore(configWith(query), new EventBus());

/* ------------------------------------------- 1. no config.query: unchanged behaviour */

const plain = storeWith(undefined);
check('no config.query: sort seeds from layout.defaultSort', plain.query.sort === 'name');
check('no config.query: dir seeds from layout.defaultSort', plain.query.dir === 'asc');
check('no config.query: search empty', plain.query.search === '');
check('no config.query: filters empty', Object.keys(plain.query.filters).length === 0);

/* ------------------------------------------------- 2. restored query fully adopted */

const restored = storeWith({
    search: 'bol',
    sort: 'qty',
    dir: 'desc',
    filters: { type: 'goods', active: 'yes' },
    perPage: 25,
});
check('restored: sort adopted over defaultSort', restored.query.sort === 'qty');
check('restored: dir adopted', restored.query.dir === 'desc');
check('restored: search adopted', restored.query.search === 'bol');
check('restored: filters adopted',
    restored.query.filters.type === 'goods' && restored.query.filters.active === 'yes');

/* ------------------------- 3. an explicitly cleared query does not resurrect defaults */

const cleared = storeWith({ search: '', sort: null, dir: 'asc', filters: {}, perPage: 25 });
check('cleared: sort stays null (defaultSort is not re-applied behind the server)',
    cleared.query.sort === null);
check('cleared: filters stay empty', Object.keys(cleared.query.filters).length === 0);

/* ------------------------------------------------------------ 4. dir normalisation */

const junk = storeWith({ search: '', sort: 'qty', dir: 'sideways', filters: {}, perPage: 25 });
check('junk dir normalises to asc', junk.query.dir === 'asc');

/* ------------------------------------------------------- 5. filters are copied, not aliased */

const source = { search: '', sort: 'name', dir: 'asc', filters: { type: 'goods' }, perPage: 25 };
const copied = new StateStore(configWith(source), new EventBus());
copied.query.filters.type = 'service';
check('filters object is copied, not aliased into the config',
    source.filters.type === 'goods', `config now says ${source.filters.type}`);

/* --------------------------------------- 6. PageSource seeds its cache at the restored key */

const seeded = storeWith({
    search: 'bol',
    sort: 'qty',
    dir: 'desc',
    filters: { type: 'goods' },
    perPage: 25,
});
const pageSource = new PageSource(seeded, new EventBus(), {});
const signature = pageSource.signatureOf(seeded.query);
check('PageSource cache is seeded under the RESTORED signature (no boot refetch)',
    pageSource.cache.get(signature) !== undefined, signature);
check('the default-query signature is NOT in the cache',
    pageSource.cache.get(pageSource.signatureOf({
        sort: 'name', dir: 'asc', search: '', filters: {}, page: 1, perPage: 25,
    })) === undefined);

/* ------------------------------------------------------------------ summary */

if (failures > 0) {
    console.error(`\nquery seed: ${failures} assertion(s) FAILED`);
    process.exit(1);
}
console.log('\nquery seed: all assertions passed');
