/**
 * Node harness: pins the BOOT-ORDER CONTRACT of resources/js/index.js — the fix for the
 * "app-side registrations can never land before the first paint" bug.
 *
 * The contract under test:
 *   1. A consumer-seeded `window.LaraGrid.pending` queue (from a script that ran BEFORE the
 *      bundle) is drained before the first scan/paint — a pending-registered formatter wins
 *      the first paint instead of falling back to textFormatter. (The actual regression.)
 *   2. The queue drains exactly once — re-evaluating the bundle never double-registers.
 *   3. The pre-seeded queue (and any other consumer key) survives the Object.assign merge.
 *   4. Absent / non-array `pending` is a no-op; the live sink is installed regardless, so a
 *      post-boot push registers immediately.
 *   5. A throwing callback surfaces — never swallowed.
 *   6. Scheduling: at readyState 'interactive' the first scan waits for DOMContentLoaded
 *      (with `load` as the post-DCL-injection net, fired-once guarded); at 'complete' it
 *      runs synchronously.
 *
 * Runs against the REAL index.js with a minimal DOM stub (no jsdom); fresh module instances
 * via cache-busting import queries. Exits non-zero on any failure.
 * Invoke directly: `node tests/js/run-boot-order.mjs` (also part of `npm test`).
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const indexUrl = (tag) =>
    pathToFileURL(resolve(root, 'resources', 'js', 'index.js')).href + '?case=' + tag;

/* ------------------------------------------------------------------ DOM stub */

const log = []; // ordered event log — the heart of the order assertions

globalThis.Element = class Element {};

class FakeRoot extends Element {
    matches() {
        return false;
    }

    querySelectorAll() {
        log.push('scan');
        return [];
    }
}

const listeners = { document: {}, window: {} };
const on = (bucket) => (type, fn) => {
    (listeners[bucket][type] ||= []).push(fn);
};
const fire = (bucket, type) => {
    const fns = listeners[bucket][type] || [];
    listeners[bucket][type] = []; // {once:true} semantics
    fns.forEach((fn) => fn());
};

globalThis.document = {
    readyState: 'interactive', // what a `defer` script actually sees — the bug's home turf
    addEventListener: on('document'),
    removeEventListener() {},
    documentElement: new FakeRoot(),
};

globalThis.window = {
    addEventListener: on('window'),
    removeEventListener() {},
};

globalThis.MutationObserver = class {
    constructor(cb) {
        this.cb = cb;
    }

    observe() {
        log.push('observe');
    }

    disconnect() {}
};

/* ------------------------------------------------------------------ assertions */

let failures = 0;
const check = (name, cond, detail = '') => {
    if (cond) {
        console.log(`  ok    ${name}`);
    } else {
        failures++;
        console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    }
};

/* ---------------------------------------------------- case 1: the regression */

let runs = 0;
window.LaraGrid = {
    customMarker: 42, // proves the merge preserves arbitrary consumer keys
    pending: [
        (LG) => {
            runs++;
            log.push('register');
            LG.registerFormatter('inr', (paise) => '₹' + (Number(paise) / 100).toFixed(2));
        },
    ],
};

await import(indexUrl(1));

console.log('pending queue drains before the first scan:');
check('callback ran during import (before DCL)', runs === 1, `runs=${runs}`);
check('no scan before DOMContentLoaded', !log.includes('scan'), `log=${log.join(',')}`);
check('registration precedes any paint', log[0] === 'register', `log=${log.join(',')}`);

const { formatValue } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'format', 'formatters.js')).href
);
check(
    'pending-registered formatter wins (no textFormatter fallback)',
    formatValue({ name: 'inr' }, 12500) === '₹125.00',
    `got "${formatValue({ name: 'inr' }, 12500)}"`,
);

console.log('the Object.assign merge:');
check('pre-seeded consumer key survives', window.LaraGrid.customMarker === 42);
check('package API merged in', typeof window.LaraGrid.boot === 'function');
check('el() helper exported', typeof window.LaraGrid.el === 'function');

console.log('scheduling at readyState=interactive:');
fire('document', 'DOMContentLoaded');
check('scan fires on DCL', log.filter((e) => e === 'scan').length === 1, `log=${log.join(',')}`);
check('observer installed after scan', log.indexOf('observe') > log.indexOf('scan'));
fire('window', 'load');
check(
    'late load event does not rescan (started-once guard)',
    log.filter((e) => e === 'scan').length === 1,
    `log=${log.join(',')}`,
);

/* ------------------------------------- case 2: drain exactly once + live sink */

document.readyState = 'complete'; // remaining cases exercise the synchronous branch
const scansBefore = log.filter((e) => e === 'scan').length;
await import(indexUrl(2));

console.log('re-evaluation of the bundle:');
check('queue does not double-drain', runs === 1, `runs=${runs}`);
check(
    'readyState=complete boots synchronously',
    log.filter((e) => e === 'scan').length === scansBefore + 1,
    `log=${log.join(',')}`,
);

window.LaraGrid.pending.push(() => {
    runs++;
    log.push('late-push');
});
check('post-boot push registers immediately (live sink)', runs === 2 && log.includes('late-push'));

/* --------------------------------------- case 3+4: absent / non-array pending */

console.log('degenerate queues:');
delete window.LaraGrid;
let threw = null;
try {
    await import(indexUrl(3));
} catch (e) {
    threw = e;
}
check('absent window.LaraGrid → no throw', threw === null, threw && threw.message);
check('sink installed even with no queue', typeof window.LaraGrid.pending.push === 'function');

window.LaraGrid = { pending: 'nonsense' };
threw = null;
try {
    await import(indexUrl(4));
} catch (e) {
    threw = e;
}
check('non-array pending → no-op, no throw', threw === null, threw && threw.message);

/* --------------------------------------------- case 5: exceptions surface */

window.LaraGrid = {
    pending: [
        () => {
            throw new Error('boom: broken consumer registration');
        },
    ],
};
threw = null;
try {
    await import(indexUrl(5));
} catch (e) {
    threw = e;
}
check(
    'throwing callback surfaces (not swallowed)',
    threw !== null && threw.message.startsWith('boom'),
    threw ? threw.message : 'no exception raised',
);

/* ------------------------------------------------------------------ summary */

if (failures > 0) {
    console.error(`\nboot-order: ${failures} assertion(s) FAILED`);
    process.exit(1);
}
console.log('\nboot-order: all assertions passed');
