/**
 * LaraGrid — vanilla boot module (no Alpine, no framework).
 *
 * What: Discovers `[data-lgrid]` mounts, reads each one's JSON config from its
 *       `<script type="application/json" data-lgrid-config>` child, resolves the DOM refs by
 *       `data-lgrid-ref` attribute, builds a GridCore per mount, and owns the full lifecycle:
 *       initial scan, grids that ARRIVE later (a Livewire morph rendering a modal that contains
 *       a grid), and grids that LEAVE the DOM (destroyed + deregistered) — via one document-level
 *       MutationObserver. Also exposes the public extension API as `window.LaraGrid`.
 *
 * Why:  The engine is deliberately framework-free; Alpine's only historical job was this file.
 *       Going vanilla removes the `alpine:init` ordering constraint entirely and makes plain
 *       Blade pages (display grids, no Livewire) first-class. Livewire integration is a LAZY
 *       facade: a mount inside a `[wire:id]` component gets a `wire` object whose RPC methods
 *       resolve `Livewire.find(id)` at CALL time — so script order vs Livewire's boot never
 *       matters, and a grid outside any Livewire component simply gets `wire: null` (display
 *       mode, exactly as before).
 *
 * When: Bundled as the entry of dist/laragrid.min.js (auto-boots on import); ESM consumers
 *       get the same auto-boot plus the named exports for custom builds.
 */
import GridCore from './core/GridCore.js';
import { registerPainter } from './render/CellPainters.js';
import { registerEditor } from './edit/EditorRegistry.js';
import { registerFormatter } from './format/formatters.js';
import { registerCast } from './format/parse.js';

/** Every live mount: root element → GridCore. Iterable so removals can be matched. */
const cores = new Map();

/** The document-level observer (created once by boot()). */
let observer = null;

/**
 * Resolve a mount's refs by `data-lgrid-ref` attribute. Absent refs stay undefined — GridCore
 * already treats each optional ref as "that feature disabled" (announcer, statusbar, ...).
 */
function resolveRefs(root) {
    const ref = (name) => root.querySelector(`[data-lgrid-ref="${name}"]`) || undefined;

    return {
        root,
        toolbar: ref('toolbar'),
        scroll: ref('scroll'),
        head: ref('head'),
        body: ref('body'),
        footer: ref('footer'),
        announcer: ref('announcer'),
        statusbar: ref('statusbar'),
        pagination: ref('pagination'),
        loading: ref('loading'),
        emptyTemplate: ref('emptyTemplate'),
        editor: ref('editor'),
        errorCount: ref('errorCount'),
        popup: ref('popup'),
        wire: resolveWire(root),
    };
}

/**
 * Build the lazy Livewire facade for a mount, or null when the mount sits outside any Livewire
 * component. The component is looked up at CALL time (never cached), so it survives script-order
 * races at boot AND Livewire swapping the component instance across navigations.
 */
function resolveWire(root) {
    const host = root.closest('[wire\\:id]');
    if (!host) {
        return null;
    }

    const call = (method) => (...args) => {
        const livewire = window.Livewire;
        if (!livewire || typeof livewire.find !== 'function') {
            return Promise.reject(new Error('LaraGrid: Livewire is not available for RPC "' + method + '".'));
        }
        const found = livewire.find(host.getAttribute('wire:id'));
        const wire = found && (found.$wire || found);
        if (!wire || typeof wire[method] !== 'function') {
            return Promise.reject(new Error('LaraGrid: Livewire component has no "' + method + '" (is the WithLaraGrid trait applied?).'));
        }
        return wire[method](...args);
    };

    return {
        gridFetch: call('gridFetch'),
        gridOps: call('gridOps'),
        gridOptions: call('gridOptions'),
        gridAction: call('gridAction'),
    };
}

/** Read the mount's embedded JSON config; a missing/invalid block mounts nothing (loud in console). */
function readConfig(root) {
    const holder = root.querySelector('script[type="application/json"][data-lgrid-config]');
    if (!holder) {
        console.error('LaraGrid: mount has no [data-lgrid-config] JSON block.', root);
        return null;
    }
    try {
        return JSON.parse(holder.textContent);
    } catch (e) {
        console.error('LaraGrid: invalid JSON in [data-lgrid-config].', root, e);
        return null;
    }
}

/**
 * Mount one grid root (idempotent — a booted mount is skipped). Exported for advanced manual
 * use; normal pages never call it, the scanner does.
 *
 * @param {HTMLElement} root the [data-lgrid] element
 * @returns {GridCore|null}
 */
export function mount(root) {
    if (cores.has(root)) {
        return cores.get(root);
    }
    const config = readConfig(root);
    if (!config) {
        return null;
    }
    const core = new GridCore(config, resolveRefs(root));
    cores.set(root, core);
    core.init();
    return core;
}

/** Destroy the grid mounted on `root` (if any) and deregister it. */
export function unmount(root) {
    const core = cores.get(root);
    if (core) {
        core.destroy();
        cores.delete(root);
    }
}

/** The GridCore mounted on (or containing) `el`, for host-page scripting. */
export function find(el) {
    const root = el && el.closest ? el.closest('[data-lgrid]') : null;
    return root ? cores.get(root) || null : null;
}

/** Scan a subtree for unmounted grids and mount them. */
function scan(node) {
    if (!(node instanceof Element)) {
        return;
    }
    if (node.matches && node.matches('[data-lgrid]')) {
        mount(node);
    }
    node.querySelectorAll && node.querySelectorAll('[data-lgrid]').forEach((el) => mount(el));
}

/** Destroy any tracked mounts inside a removed subtree. */
function reap(node) {
    if (!(node instanceof Element)) {
        return;
    }
    for (const [root] of cores) {
        if (node === root || node.contains(root)) {
            unmount(root);
        }
    }
}

/**
 * Start LaraGrid: initial scan + the arrival/removal observer. Idempotent. Runs automatically
 * on import; exported so a consumer with unusual bootstrapping can call it explicitly.
 */
export function boot() {
    if (observer) {
        return;
    }

    const start = () => {
        scan(document.documentElement);
        observer = new MutationObserver((records) => {
            for (const record of records) {
                record.removedNodes.forEach((node) => reap(node));
                record.addedNodes.forEach((node) => scan(node));
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
        // Mark "booted" immediately so a second boot() before DOMContentLoaded stays a no-op.
        observer = /** @type {any} */ ({ pending: true });
        return;
    }

    start();
}

/**
 * The public extension surface, mirrored onto window.LaraGrid by boot below:
 * painters/editors (custom column UI), formatters/casts (the JS twins of the PHP registries),
 * and mount/unmount/find for host-page scripting.
 */
export const LaraGrid = {
    boot,
    mount,
    unmount,
    find,
    registerPainter,
    registerEditor,
    registerFormatter,
    registerCast,
};

if (typeof window !== 'undefined') {
    window.LaraGrid = Object.assign(window.LaraGrid || {}, LaraGrid);
    boot();
}

export default LaraGrid;
