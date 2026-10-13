/**
 * Node harness: exercise the REAL picker option cache key (edit/optionCacheKey.js) — the key
 * EditorManager.searchOptions() uses for its per-column LRU. Exits non-zero on any mismatch.
 * Invoked by tests/Feature/Grid/OptionCacheKeyVectorsTest.php via Symfony Process (skipped when
 * node is unavailable) and runnable directly: `node tests/js/run-option-cache-key.mjs`.
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const { optionCacheKey } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'edit', 'optionCacheKey.js')).href
);

const failures = [];
const check = (name, cond) => {
    if (!cond) {
        failures.push(name);
    }
};

const plain = { key: 'account_id' };
const sided = { key: 'account_id', optionsDependOn: ['dc'] };

// 1. A column without dependencies keeps the plain term key (pre-existing cache behaviour).
check('plain-term', optionCacheKey(plain, { dc: 'D' }, 'cash') === 'cash');
check('plain-null-term', optionCacheKey(plain, { dc: 'D' }, null) === '');
check('plain-ignores-row', optionCacheKey(plain, { dc: 'D' }, 'x') === optionCacheKey(plain, { dc: 'C' }, 'x'));

// 2. A declared dependency separates rows that search the same term.
check('dependency-splits', optionCacheKey(sided, { dc: 'D' }, '') !== optionCacheKey(sided, { dc: 'C' }, ''));

// 3. The same term and dependency value share one key (the cache still works).
check('dependency-shares', optionCacheKey(sided, { dc: 'D', other: 1 }, 'ba') === optionCacheKey(sided, { dc: 'D', other: 2 }, 'ba'));

// 4. Different terms with the same dependency value stay distinct.
check('term-splits', optionCacheKey(sided, { dc: 'D' }, 'a') !== optionCacheKey(sided, { dc: 'D' }, 'b'));

// 5. A missing row or value is a stable blank, never a crash.
check('missing-row', optionCacheKey(sided, null, 'a') === optionCacheKey(sided, {}, 'a'));
check('null-value', optionCacheKey(sided, { dc: null }, 'a') === optionCacheKey(sided, {}, 'a'));

// 6. Values cannot collide across the term/value boundary.
check('no-boundary-collision', optionCacheKey({ optionsDependOn: ['a', 'b'] }, { a: 'x|', b: 'y' }, 't')
    !== optionCacheKey({ optionsDependOn: ['a', 'b'] }, { a: 'x', b: '|y' }, 't'));

if (failures.length > 0) {
    console.error(`Option cache key vectors FAILED: ${failures.join(', ')}`);
    process.exit(1);
}

console.log('Option cache key vectors OK');
