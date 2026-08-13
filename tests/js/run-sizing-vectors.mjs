/**
 * Pins the sizing-chain contract across GridCore and CSS. In particular, fixed/minimum-height
 * grids must use an inner flex stack whose footer consumes spare vertical space; `position:
 * sticky; bottom: 0` alone leaves the footer directly below a short body.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const GridCore = (await import(
    pathToFileURL(resolve(root, 'resources', 'js', 'core', 'GridCore.js')).href
)).default;

let failures = 0;
const check = (name, condition, detail = '') => {
    if (condition) {
        console.log(`  ok    ${name}`);
        return;
    }
    failures++;
    console.error(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};

const fakeElement = () => {
    const classes = new Set();
    const properties = new Map();
    return {
        classes,
        properties,
        style: {
            setProperty(name, value) {
                properties.set(name, value);
            },
        },
        classList: {
            add(name) {
                classes.add(name);
            },
        },
    };
};

const rootEl = fakeElement();
const scrollEl = fakeElement();
GridCore.prototype.applySizing.call({
    store: {
        layout: {
            sizing: {
                height: '420px',
                minHeight: '300px',
                maxHeight: '60vh',
                fill: true,
            },
        },
    },
    refs: { root: rootEl, scroll: scrollEl },
});

console.log('declarative sizing application:');
check('height reaches the grid root', rootEl.style.height === '420px');
check('minimum height reaches the grid root', rootEl.style.minHeight === '300px');
check('height/fill enables fixed flex sizing', rootEl.classes.has('lgrid--fill'));
check('minimum height enables short-grid footer alignment', rootEl.classes.has('lgrid--min-height'));
check('maxHeight reaches the scroll token', scrollEl.properties.get('--lgrid-max-h') === '60vh');

const css = readFileSync(resolve(root, 'resources', 'css', 'laragrid.css'), 'utf8');
console.log('short-grid footer layout:');
check(
    'fixed and minimum sizing flex the inner scroll stack',
    /\.lgrid--fill \.lgrid-scroll,\s*\.lgrid--min-height \.lgrid-scroll\s*{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s.test(css),
);
check(
    'the footer consumes spare inner height',
    /\.lgrid--fill \.lgrid-footer,\s*\.lgrid--min-height \.lgrid-footer\s*{[^}]*margin-top:\s*auto;/s.test(css),
);

if (failures > 0) {
    console.error(`\nsizing-vectors: ${failures} assertion(s) FAILED`);
    process.exit(1);
}
console.log('\nsizing-vectors: all assertions passed');
