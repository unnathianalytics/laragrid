/**
 * Node harness: exercise the REAL datagrid Lru module (util/lru.js) — the PageSource cache —
 * against a handful of eviction/recency vectors. Exits non-zero on any mismatch. Invoked by
 * tests/Feature/Grid/LruVectorsTest.php via Symfony Process (skipped when node is unavailable) and
 * runnable directly: `node tests/js/run-lru-vectors.mjs`. Mirrors run-nav-vectors.mjs.
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const jsBase = resolve(root, 'resources', 'js');

const { default: Lru } = await import(pathToFileURL(resolve(jsBase, 'util', 'lru.js')).href);

const failures = [];
const check = (name, cond) => {
    if (!cond) {
        failures.push(name);
    }
};

// 1. Evicts the least-recently-used key past capacity.
{
    const lru = new Lru(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3); // evicts 'a' (LRU)
    check('evict-lru', !lru.has('a') && lru.has('b') && lru.has('c'));
}

// 2. get() refreshes recency so the touched key survives the next eviction.
{
    const lru = new Lru(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a'); // 'a' now most-recent
    lru.set('c', 3); // evicts 'b'
    check('get-refreshes', lru.has('a') && !lru.has('b') && lru.has('c'));
}

// 3. re-set() of an existing key updates value + recency without growing size.
{
    const lru = new Lru(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('a', 9); // refresh 'a'
    lru.set('c', 3); // evicts 'b'
    check('reset-refreshes', lru.get('a') === 9 && !lru.has('b') && lru.has('c') && lru.size === 2);
}

// 4. miss returns undefined; capacity floors at 1.
{
    const lru = new Lru(0);
    check('capacity-floor', lru.capacity === 1);
    check('miss-undefined', lru.get('nope') === undefined);
}

if (failures.length > 0) {
    console.error('LRU vector failures:\n' + failures.map((f) => ' - ' + f).join('\n'));
    process.exit(1);
}

console.log('LRU vectors OK');
process.exit(0);
