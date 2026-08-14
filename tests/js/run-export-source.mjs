/**
 * Node harness for the mode-independent export RPC seam used by resolver-backed display grids.
 * It pins that export sends only current-view intent, never calls gridFetch, and emits lifecycle
 * events. Invoke directly or through `npm test`.
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const jsBase = resolve(root, 'resources', 'js');

const { default: EventBus } = await import(pathToFileURL(resolve(jsBase, 'core', 'EventBus.js')).href);
const { default: ExportSource } = await import(pathToFileURL(resolve(jsBase, 'sync', 'ExportSource.js')).href);

const failures = [];
const check = (name, condition) => {
    if (!condition) failures.push(name);
};

const events = [];
const calls = [];
const bus = new EventBus();
bus.on('export:started', (detail) => events.push(['started', detail.format]));
bus.on('export:done', (detail) => events.push(['done', detail.format]));
bus.on('export:error', (detail) => events.push(['error', detail.format]));

const store = {
    name: 'dayBook',
    query: {
        sort: 'date',
        dir: 'desc',
        search: 'cash',
        filters: { type: 'payment' },
        page: 7,
        perPage: 100,
    },
};
const wire = {
    gridExport: async (name, format, state) => calls.push({ name, format, state }),
    gridFetch: () => { throw new Error('export-only source must never fetch'); },
};

await new ExportSource(store, bus, wire).export('csv');

check('one export RPC', calls.length === 1);
check('grid identity and format', calls[0].name === 'dayBook' && calls[0].format === 'csv');
check('sort/search/filter sent', calls[0].state.sort === 'date'
    && calls[0].state.dir === 'desc'
    && calls[0].state.search === 'cash'
    && calls[0].state.filters.type === 'payment');
check('pagination stripped', !('page' in calls[0].state) && !('perPage' in calls[0].state));
check('lifecycle events', JSON.stringify(events) === JSON.stringify([['started', 'csv'], ['done', 'csv']]));

if (failures.length > 0) {
    console.error('ExportSource vector failures:\n' + failures.map((failure) => ' - ' + failure).join('\n'));
    process.exit(1);
}

console.log('ExportSource vectors OK');
