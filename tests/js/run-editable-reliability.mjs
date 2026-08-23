import assert from 'node:assert/strict';
import EventBus from '../../resources/js/core/EventBus.js';
import StateStore from '../../resources/js/core/StateStore.js';
import SyncManager from '../../resources/js/sync/SyncManager.js';
import DraftStore from '../../resources/js/persist/DraftStore.js';
import ErrorPainter from '../../resources/js/render/ErrorPainter.js';
import BodyRenderer from '../../resources/js/render/BodyRenderer.js';

function config(rows = [{ _k: 'r1', name: 'old' }], sync = 'deferred') {
    return {
        name: 'lines',
        columns: [{ key: 'name', label: 'Name', editable: true, visible: true }],
        rows,
        layout: { editable: true, sync },
    };
}

function makeTarget(extra = {}) {
    const listeners = new Map();
    return {
        hidden: false,
        attributes: new Map(),
        addEventListener(name, handler) { listeners.set(name, handler); },
        removeEventListener(name) { listeners.delete(name); },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        removeAttribute(name) { this.attributes.delete(name); },
        getAttribute(name) { return this.attributes.get(name) || null; },
        focus() {},
        ...extra,
    };
}

// Draft round-trip: rows + queued op + active state recover, and acknowledgement does not erase
// the draft before the host confirms a durable save.
{
    const records = new Map();
    const backend = {
        async get(key) { return records.get(key) || null; },
        async put(key, value) { records.set(key, value); },
        async delete(key) { records.delete(key); },
    };
    const refs1 = {
        draftBar: makeTarget({ hidden: true }),
        draftMessage: makeTarget({ textContent: '' }),
        draftRestore: makeTarget(),
        draftDiscard: makeTarget(),
    };
    const bus1 = new EventBus();
    const store1 = new StateStore(config(), bus1);
    const sync1 = new SyncManager(store1, bus1, { gridOps: async () => ({}) });
    const draft1 = new DraftStore(
        { mode: 'local', key: 'tenant:voucher' },
        store1,
        sync1,
        bus1,
        refs1,
        { backend, debounceMs: 1 },
    );
    await draft1.init();
    const cells = store1.applyLocalSet('r1', 'name', 'recovered');
    sync1.enqueue({ seq: store1.nextSeq(), t: 'set', row: 'r1', col: 'name', v: 'recovered' }, cells);
    store1.setActive({ rowKey: 'r1', colKey: 'name' });
    await draft1.saveNow();
    assert.equal(records.size, 1);
    draft1.destroy();
    sync1.destroy();

    const refs2 = {
        draftBar: makeTarget({ hidden: true }),
        draftMessage: makeTarget({ textContent: '' }),
        draftRestore: makeTarget(),
        draftDiscard: makeTarget(),
    };
    const bus2 = new EventBus();
    const store2 = new StateStore(config(), bus2);
    const sync2 = new SyncManager(store2, bus2, {
        gridOps: async (_name, batch) => ({
            version: 1,
            footer: {},
            results: batch.ops.map((op) => ({ seq: op.seq, ok: true, patch: [], errors: [] })),
        }),
        gridRestoreDraft: async (_name, payload) => ({
            version: 1,
            footer: {},
            results: [],
            rows: payload.rows,
        }),
    });
    const draft2 = new DraftStore(
        { mode: 'local', key: 'tenant:voucher' },
        store2,
        sync2,
        bus2,
        refs2,
        { backend, debounceMs: 1 },
    );
    await draft2.init();
    assert.equal(refs2.draftBar.hidden, false);
    assert.match(refs2.draftMessage.textContent, /Unsaved grid changes/);
    await draft2.restoreCandidate();
    await sync2.whenSettled();
    assert.equal(store2.rowByKey.get('r1').row.name, 'recovered');
    assert.equal(store2.hasUnsavedChanges(), true);
    assert.equal(records.size, 1, 'acknowledgement is not treated as durable save');
    store2.markSaved();
    await draft2.clear();
    assert.equal(records.size, 0);
    draft2.destroy();
    sync2.destroy();
}

// Error paint stays proportional to error keys even on a large row set and exposes the message
// through ARIA/title instead of color alone.
{
    const rows = Array.from({ length: 5000 }, (_, index) => ({ _k: 'r' + index, name: '' }));
    const bus = new EventBus();
    const store = new StateStore(config(rows), bus);
    let lookups = 0;
    const classes = new Set();
    const cell = makeTarget({
        classList: {
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
        },
    });
    const renderer = {
        cellElFor() {
            lookups += 1;
            return cell;
        },
    };
    const rootClasses = new Set();
    const refs = {
        root: makeTarget({
            classList: {
                toggle(name, on) { if (on) rootClasses.add(name); else rootClasses.delete(name); },
            },
        }),
        errorCount: makeTarget({ textContent: '' }),
        errorReview: makeTarget({ hidden: true }),
        errorPrev: makeTarget({ disabled: false }),
        errorNext: makeTarget({ disabled: false }),
    };
    const painter = new ErrorPainter(store, renderer, bus, refs);
    store.setError('r4999', 'name', 'Name is required.');
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(lookups <= 2, 'one error must not scan 5,000 rendered cells');
    assert.equal(classes.has('lgrid-cell--error'), true);
    assert.equal(cell.getAttribute('aria-invalid'), 'true');
    assert.equal(cell.getAttribute('title'), 'Name is required.');
    assert.equal(refs.errorCount.textContent, '1');
    store.setError('r4999', 'name', null);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(cell.getAttribute('aria-invalid'), null);
    painter.destroy();
}

// Large bodies mount a bounded row window while keeping every row in the data store addressable.
{
    class FakeElement {
        constructor(tag = 'div', fragment = false) {
            this.tagName = tag;
            this.fragment = fragment;
            this.children = [];
            this.dataset = {};
            this.style = {};
            this.attributes = new Map();
            this._text = '';
            this.classes = new Set();
            this.classList = {
                add: (...names) => names.forEach((name) => this.classes.add(name)),
                toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
            };
        }
        set className(value) {
            this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
        }
        get className() { return [...this.classes].join(' '); }
        set textContent(value) {
            this._text = String(value ?? '');
            if (this._text === '') this.children = [];
        }
        get textContent() { return this._text; }
        appendChild(child) {
            if (child.fragment) this.children.push(...child.children);
            else this.children.push(child);
            return child;
        }
        setAttribute(name, value) { this.attributes.set(name, String(value)); }
        addEventListener() {}
        removeEventListener() {}
    }

    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        getComputedStyle: globalThis.getComputedStyle,
    };
    globalThis.document = {
        documentElement: new FakeElement('html'),
        createElement: (tag) => new FakeElement(tag),
        createDocumentFragment: () => new FakeElement('fragment', true),
    };
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.getComputedStyle = (element) => ({
        getPropertyValue: () => '1.5rem',
        fontSize: element === globalThis.document.documentElement ? '16px' : '16px',
    });

    const rows = Array.from({ length: 2000 }, (_, index) => ({ _k: 'r' + index, name: 'N' + index }));
    const bus = new EventBus();
    const store = new StateStore(config(rows), bus);
    store.columns[0].painter = 'text';
    const root = new FakeElement();
    const scroll = new FakeElement();
    scroll.clientHeight = 240;
    scroll.scrollTop = 0;
    const head = new FakeElement();
    head.offsetHeight = 24;
    const layout = {
        refs: { root, scroll, head },
        applyFrozenTo() {},
        fillerCell: () => new FakeElement(),
    };
    const body = new FakeElement();
    const renderer = new BodyRenderer(store, layout, body, bus);
    renderer.render();
    assert.equal(renderer.virtual, true);
    assert.ok(renderer.rowElByKey.size < 100, 'virtual DOM window must remain bounded');
    assert.equal(store.rowCount(), 2000);
    assert.ok(renderer.ensureCellElFor('r1999', 'name'));
    assert.equal(renderer.rowElByKey.has('r1999'), true);
    renderer.destroy();

    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.getComputedStyle = previous.getComputedStyle;
}

console.log('editable reliability vectors: ok');
