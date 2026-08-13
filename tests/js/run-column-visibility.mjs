/** Pin definition-hidden versus chooser-hidden column semantics against the real store. */
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
const { default: ColumnChooser } = await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'render', 'ColumnChooser.js')).href
);

let failures = 0;
const check = (name, condition) => {
    if (condition) {
        console.log(`  ok    ${name}`);
    } else {
        failures++;
        console.error(`  FAIL  ${name}`);
    }
};

const store = new StateStore({
    name: 'visibility',
    columns: [
        { key: 'always', visible: true },
        { key: 'optional', visible: true, hiddenByDefault: true },
        { key: 'internal', visible: false },
    ],
    layout: {},
    rows: [{ _k: 'a', always: 1, optional: 2, internal: 3 }],
}, new EventBus());

console.log('column visibility defaults:');
check('default-hidden column starts hidden', !store.visibleColumns().some((c) => c.key === 'optional'));
check('default-hidden column remains definition-visible', store.columns.find((c) => c.key === 'optional').visible === true);
check('definition-hidden column stays outside visible columns', !store.visibleColumns().some((c) => c.key === 'internal'));

store.userHidden.delete('optional');
check('operator can reveal a default-hidden column', store.visibleColumns().some((c) => c.key === 'optional'));

let resetCalled = false;
let layoutChanged = false;
const rootEl = { dispatchEvent() {} };
const chooser = new ColumnChooser(store, { root: rootEl, popup: {} }, { isOpen: () => false }, {
    reset() { resetCalled = true; },
}, {
    onChange() { layoutChanged = true; },
});
chooser.reset();

check('Reset Layout restores the declared hidden default', store.userHidden.has('optional'));
check('Reset Layout clears persisted overrides', resetCalled);
check('Reset Layout triggers relayout', layoutChanged);

if (failures) {
    process.exitCode = 1;
} else {
    console.log('\ncolumn visibility: all assertions passed');
}
