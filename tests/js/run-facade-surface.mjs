/**
 * Node harness: pins the LIVEWIRE FACADE SURFACE — every grid RPC any engine module invokes
 * as `wire.gridX(...)` must be defined in resolveWire()'s facade in resources/js/index.js.
 *
 * Why this exists: the facade is the ONLY bridge from the vanilla engine to the host
 * component, and a missing key is `undefined`, not an error — callers that feature-detect
 * (e.g. PageSource.export's `typeof this.wire.gridExport !== 'function'` guard) degrade to
 * a SILENT no-op. That is exactly how exports shipped broken in v0.1.15: gridExport existed
 * on the trait, in PageSource, and in the toolbar, but was never added to the facade, so
 * the Export button did nothing with no console error. This check makes that class of
 * drift impossible: add a new `wire.gridX` call site anywhere and the suite fails until
 * the facade lists it.
 *
 * Static source check (no DOM needed). Exits non-zero listing the missing RPCs.
 * Invoke directly: `node tests/js/run-facade-surface.mjs` (also part of `npm test`).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const jsRoot = resolve(here, '..', '..', 'resources', 'js');

/** Recursively collect every .js file under resources/js. */
const files = [];
const walk = (dir) => {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            walk(path);
        } else if (name.endsWith('.js')) {
            files.push(path);
        }
    }
};
walk(jsRoot);

const indexPath = join(jsRoot, 'index.js');
const indexSrc = readFileSync(indexPath, 'utf8');

// Every RPC name used anywhere in the engine as `wire.gridX` / `this.wire.gridX`
// (whitespace-tolerant; index.js excluded — it defines the facade, it doesn't consume it).
const used = new Set();
for (const file of files) {
    if (file === indexPath) {
        continue;
    }
    for (const match of readFileSync(file, 'utf8').matchAll(/\bwire\s*\.\s*(grid[A-Z]\w*)/g)) {
        used.add(match[1]);
    }
}

// Every RPC the facade actually exposes: `gridX: call('gridX')`.
const exposed = new Set();
for (const match of indexSrc.matchAll(/(grid[A-Z]\w*)\s*:\s*call\(\s*'(grid[A-Z]\w*)'\s*\)/g)) {
    if (match[1] === match[2]) {
        exposed.add(match[1]);
    }
}

let failures = 0;
console.log(`facade surface: ${used.size} RPC(s) used by the engine, ${exposed.size} exposed by the facade`);

for (const name of [...used].sort()) {
    if (exposed.has(name)) {
        console.log(`  ok    ${name}`);
    } else {
        failures++;
        console.error(`  FAIL  ${name} — used as wire.${name}(...) but NOT defined in resolveWire()'s facade (silent no-op at runtime)`);
    }
}

if (used.size === 0) {
    failures++;
    console.error('  FAIL  no wire.gridX usages found — the scan regex is broken, not the code');
}

if (failures > 0) {
    console.error(`\nfacade-surface: ${failures} check(s) FAILED`);
    process.exit(1);
}
console.log('\nfacade-surface: all checks passed');
