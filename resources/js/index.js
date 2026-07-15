/**
 * LaraGrid — vanilla boot module (framework-free).
 *
 * What: Discovers `[data-lgrid]` mounts, reads each one's JSON config from its
 *       `<script type="application/json" data-lgrid-config>` child, resolves the DOM refs by
 *       `data-lgrid-ref` attribute, builds a GridCore per mount, and owns the full lifecycle:
 *       initial scan, grids that ARRIVE later (a Livewire morph rendering a modal that contains
 *       a grid), and grids that LEAVE the DOM (destroyed + deregistered) — via one document-level
 *       MutationObserver. Also exposes the public extension API as `window.LaraGrid`.
 *
 * Why:  The engine is deliberately framework-free, so script load order never matters and
 *       plain Blade pages (display grids, no Livewire) are first-class. Livewire integration
 *       is a LAZY
 *       facade: a mount inside a `[wire:id]` component gets a `wire` object whose RPC methods
 *       resolve `Livewire.find(id)` at CALL time — so script order vs Livewire's boot never
 *       matters, and a grid outside any Livewire component simply gets `wire: null` (display
 *       mode, exactly as before).
 *
 * When: Bundled as the entry of dist/laragrid.min.js (auto-boots on import); ESM consumers
 *       get the same auto-boot plus the named exports for custom builds. Boot order contract:
 *       on import the module (1) merges the public API onto window.LaraGrid, (2) drains the
 *       consumer's pre-seeded `window.LaraGrid.pending` registration queue, and (3) schedules
 *       the first scan for DOMContentLoaded — so app registrations land before the first
 *       paint REGARDLESS of whether the app's script ran before or after this bundle.
 */
import GridCore from './core/GridCore.js';
import { registerPainter } from './render/CellPainters.js';
import { registerEditor } from './edit/EditorRegistry.js';
import { registerFormatter } from './format/formatters.js';
import { registerCast } from './format/parse.js';
import { el } from './util/dom.js';

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

    /**
     * Resolve a callable $wire for `method`, trying every shape Livewire builds have used:
     * the component instance attached to the root element (`el.__livewire` — the most stable
     * seam across Livewire 3/4), then `Livewire.find(id)` (which returns the component in
     * some builds, the $wire proxy in others, undefined/throws in yet others).
     */
    const wireFor = (method) => {
        const candidates = [host.__livewire];
        const livewire = window.Livewire;
        if (livewire && typeof livewire.find === 'function') {
            try {
                candidates.push(livewire.find(host.getAttribute('wire:id')));
            } catch (e) {
                // An unknown-id throw just disqualifies this candidate.
            }
        }
        for (const candidate of candidates) {
            if (!candidate) {
                continue;
            }
            if (candidate.$wire && typeof candidate.$wire[method] === 'function') {
                return candidate.$wire;
            }
            if (typeof candidate[method] === 'function') {
                return candidate;
            }
        }
        return null;
    };

    const call = (method) => (...args) => {
        // Everything sync-throwable is wrapped so a failure always becomes a rejected promise
        // (the callers' .catch pairing depends on it — e.g. the loading spinner).
        try {
            const wire = wireFor(method);
            if (!wire) {
                return Promise.reject(new Error(
                    'LaraGrid: could not resolve a Livewire $wire exposing "' + method
                    + '" (is Livewire loaded and the WithLaraGrid trait applied?).'
                ));
            }
            return Promise.resolve(wire[method](...args));
        } catch (e) {
            return Promise.reject(e);
        }
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
 *
 * Why the first scan waits for DOMContentLoaded: this bundle ships as a deferred script, so
 * import happens at readyState 'interactive' — scanning synchronously here would paint BEFORE
 * any other deferred script (the app's own bundle, later in <head>) gets to register its
 * formatters/casts/painters/editors. Deferring the scan to DCL means every deferred consumer
 * script — before or after this bundle in the document — has executed before the first paint.
 * 'interactive' is ambiguous (it also means "DCL already fired, subresources loading"), so a
 * `load` listener is the safety net for post-DCL injection, and readyState 'complete' (post-
 * load injection, e.g. dynamic import) starts synchronously.
 */
export function boot() {
    if (observer) {
        return;
    }

    let started = false;
    const start = () => {
        if (started) {
            return; // both DCL and load fire in the pre-DCL case — start exactly once
        }
        started = true;
        scan(document.documentElement);
        observer = new MutationObserver((records) => {
            for (const record of records) {
                record.removedNodes.forEach((node) => reap(node));
                record.addedNodes.forEach((node) => scan(node));
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    };

    if (document.readyState === 'complete') {
        start();
        return;
    }

    // Mark "booted" immediately so a second boot() before the first scan stays a no-op.
    observer = /** @type {any} */ ({ pending: true });
    document.addEventListener('DOMContentLoaded', start, { once: true });
    window.addEventListener('load', start, { once: true });
}

/**
 * Apply the consumer's queued registrations, then leave a live sink in their place.
 *
 * What: `window.LaraGrid.pending` is the ORDER-INDEPENDENT registration seam. A consumer
 *       script that runs before this bundle (the default with auto-injection, which appends
 *       the bundle at the end of <head>) cannot call the API — it doesn't exist yet — so it
 *       seeds an array of callbacks instead:
 *
 *           (window.LaraGrid = window.LaraGrid || {}).pending = [
 *               (LG) => { LG.registerFormatter('inr', …); LG.registerCast('paise', …); },
 *           ];
 *
 *       Each callback receives the public API. The queue drains here, BEFORE boot() — i.e.
 *       before the first scan/paint — which is the entire point: registrations must win the
 *       first paint, not reconcile after it.
 *
 * Why the replacement sink: after draining, `pending` becomes an object whose push() runs
 *       callbacks immediately. A script that loads after the bundle can keep using the exact
 *       same idiom (or call the API directly — same effect); nothing ever rots unread in an
 *       array. This also makes a second evaluation of the bundle harmless: the sink is not an
 *       array, so nothing double-registers.
 *
 * When: On import, between the window.LaraGrid merge and boot(). Callback exceptions are NOT
 *       swallowed — a broken registration fails as loudly as any other boot-time self-check.
 */
function drainPending(api) {
    const run = (fn) => {
        if (typeof fn === 'function') {
            fn(api);
        }
    };

    const queue = api.pending;

    // Install the live sink BEFORE draining, so a push from inside a draining callback
    // (or from any later script) registers immediately instead of being lost.
    api.pending = {
        push: (...fns) => {
            fns.forEach(run);
            return fns.length;
        },
    };

    if (Array.isArray(queue)) {
        queue.splice(0).forEach(run);
    }
}

/**
 * The public extension surface, mirrored onto window.LaraGrid by boot below:
 * painters/editors (custom column UI), formatters/casts (the JS twins of the PHP registries),
 * `el` (the element factory custom painters/editors are written against), and
 * mount/unmount/find for host-page scripting.
 */
export const LaraGrid = {
    boot,
    mount,
    unmount,
    find,
    el,
    registerPainter,
    registerEditor,
    registerFormatter,
    registerCast,
};

if (typeof window !== 'undefined') {
    // Order is load-bearing:
    //   merge  — the consumer's pre-seeded `pending` array is on the assign TARGET (and
    //            `pending` is not a key of the package export), so it survives the merge;
    //   drain  — registrations land while nothing has painted;
    //   boot   — the first scan sees the completed registries.
    window.LaraGrid = Object.assign(window.LaraGrid || {}, LaraGrid);
    drainPending(window.LaraGrid);
    boot();
}

export default LaraGrid;
