/**
 * Node harness: pins the SHELL-BOOT contract (perf plan P1) on the real GridCore + StateStore.
 * A mount whose config carries `rowsDeferred: true` (a rowsFrom-bound grid re-rendered by a
 * host update after the browser already held it) must fetch its rows through ONE
 * gridReseedRows call and adopt rows, footer and protocol version; a config without the flag
 * never calls it; a failed call clears the flag so the empty state can paint.
 * Runs with a minimal DOM stub (no jsdom). Invoke: `node tests/js/run-shell-boot.mjs`.
 */
import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsBase = resolve(here, '..', '..', 'resources', 'js');

// GridCore's module graph touches nothing at import time, but the editors it registers read
// `document` lazily; stub the few globals the constructor path can reach.
globalThis.Element = globalThis.Element || class Element {};
globalThis.document = globalThis.document || { addEventListener() {}, removeEventListener() {} };
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };

const { default: GridCore } = await import(pathToFileURL(resolve(jsBase, 'core', 'GridCore.js')).href);

const columns = [{ key: 'name', label: 'Name', editable: true, writable: true, visible: true }];

function rig({ rowsDeferred, reseed } = {}) {
    const calls = [];
    const wire = {
        gridReseedRows: async (name) => {
            calls.push(name);
            return reseed();
        },
    };
    const config = { name: 'lines', columns, rows: [], layout: { editable: true } };
    if (rowsDeferred) {
        config.rowsDeferred = true;
    }
    const core = new GridCore(config, { wire, root: { classList: { toggle() {} } } });
    return { core, calls };
}

let failures = 0;
const check = (name, cond, detail = '') => {
    if (cond) {
        console.log(`  ok    ${name}`);
    } else {
        failures++;
        console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
    }
};

// 1. A deferred config fetches once and adopts rows + footer + version.
{
    const { core, calls } = rig({
        rowsDeferred: true,
        reseed: () => ({
            rows: [{ _k: 'a', name: 'Alpha' }, { _k: 'b', name: 'Beta' }],
            footer: { amount: 42 },
            version: 7,
        }),
    });
    check('store starts deferred', core.store.rowsDeferred === true);
    const loaded = await core.loadDeferredRows();
    check('loadDeferredRows resolves true', loaded === true);
    check('one gridReseedRows call for this grid', calls.length === 1 && calls[0] === 'lines', JSON.stringify(calls));
    check('rows adopted', core.store.rowCount() === 2 && core.store.rowByKey.get('b').row.name === 'Beta');
    check('footer adopted', core.store.pageTotals.amount === 42);
    check('protocol version adopted', core.store.version === 7);
    check('deferral cleared', core.store.rowsDeferred === false);
    const again = await core.loadDeferredRows();
    check('a second call is a no-op', again === false && calls.length === 1);
}

// 2. A config without the flag never calls the RPC.
{
    const { core, calls } = rig({ rowsDeferred: false, reseed: () => ({ rows: [] }) });
    const loaded = await core.loadDeferredRows();
    check('non-deferred mount makes no call', loaded === false && calls.length === 0);
}

// 3. A failing RPC clears the flag (so the empty state may paint) and never throws.
{
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args);
    try {
        const { core, calls } = rig({ rowsDeferred: true, reseed: () => { throw new Error('boom'); } });
        const loaded = await core.loadDeferredRows();
        check('failed load resolves false', loaded === false && calls.length === 1);
        check('failed load clears the deferral', core.store.rowsDeferred === false);
        check('failure is logged, not swallowed', errors.length === 1);
    } finally {
        console.error = original;
    }
}

// 4. StateStore.reseed() clears the flag on its own (the host reseed seam shares it).
{
    const { core } = rig({ rowsDeferred: true, reseed: () => ({ rows: [] }) });
    core.store.reseed([{ _k: 'x', name: 'X' }]);
    check('reseed clears the deferral', core.store.rowsDeferred === false && core.store.rowCount() === 1);
}

// 5. A reseed that lands while the call is in flight (host lgrid:reseed, draft restore) wins.
{
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { core, calls } = rig({
        rowsDeferred: true,
        reseed: () => gate.then(() => ({ rows: [{ _k: 'stale', name: 'Stale' }], version: 9 })),
    });
    const pending = core.loadDeferredRows();
    core.store.reseed([{ _k: 'host', name: 'From host' }]);
    release();
    const applied = await pending;
    check('late response is dropped', applied === false && calls.length === 1);
    check('the earlier reseed keeps its rows', core.store.rowCount() === 1 && core.store.rowByKey.has('host'));
    check('the late version is not adopted', core.store.version === 0);
}

// 6. The facade exposes the RPC (a missing key would silently skip the load).
{
    const { readFileSync } = await import('node:fs');
    const index = readFileSync(resolve(jsBase, 'index.js'), 'utf8');
    check('facade lists gridReseedRows', /gridReseedRows:\s*call\('gridReseedRows'\)/.test(index));
}

if (failures > 0) {
    console.error(`\nshell-boot: ${failures} assertion(s) FAILED`);
    process.exit(1);
}
console.log('\nshell-boot: all assertions passed');
