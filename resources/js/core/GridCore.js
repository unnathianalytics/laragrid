/**
 * What: The per-grid orchestrator — wires the EventBus, StateStore, Layout, Renderer and (M2)
 *       the interaction managers (Selection, Keyboard, SelectionPainter, StatusBar, Clipboard,
 *       Announcer) together, receives its DOM refs from the boot mount, and owns init/destroy.
 * Why:  One object that "wires modules and owns lifecycle" (plan §2.4 GridCore) keeps the boot
 *       module (index.js) thin — it just constructs a GridCore with its config and refs
 *       and calls init() in $nextTick. The M2 interaction engines bolt on HERE (not in index.js),
 *       exactly as the M1 report reserved. Everything below the mount is plain JS-owned DOM inside
 *       `wire:ignore`, so a Livewire re-render can never touch it — and in dev we install a
 *       MutationObserver that screams if anything external mutates the body (R3, M0 follow-up #4).
 * When: Instantiated by the vanilla boot module (index.js) for each discovered mount.
 */
import EventBus from './EventBus.js';
import StateStore from './StateStore.js';
import Layout from '../render/Layout.js';
import Renderer from '../render/Renderer.js';
import SelectionManager from '../selection/SelectionManager.js';
import SelectionPainter from '../selection/SelectionPainter.js';
import KeyboardManager from '../keyboard/KeyboardManager.js';
import ClipboardManager from '../clipboard/ClipboardManager.js';
import StatusBar from '../statusbar/StatusBar.js';
import Announcer from '../a11y/Announcer.js';
import PageSource from '../sync/PageSource.js';
import PaginationBar from '../render/PaginationBar.js';
import SyncManager from '../sync/SyncManager.js';
import EditorManager from '../edit/EditorManager.js';
import ClientValidator from '../validate/ClientValidator.js';
import ErrorPainter from '../render/ErrorPainter.js';
import PopupManager from '../popup/PopupManager.js';
import LayoutStore from '../persist/LayoutStore.js';
import ResizeManager from '../resize/ResizeManager.js';
import ColumnChooser from '../render/ColumnChooser.js';
import HeaderFilters from '../render/HeaderFilters.js';
import Toolbar from '../render/Toolbar.js';
import RowActivator from '../interact/RowActivator.js';
import ActionRunner from '../interact/ActionRunner.js';
import '../edit/builtin.js';

export default class GridCore {
    /**
     * @param {object} config the @js() config from ConfigSerializer
     * @param {{root: HTMLElement, scroll: HTMLElement, head: HTMLElement, body: HTMLElement, footer: HTMLElement, announcer?: HTMLElement, statusbar?: HTMLElement}} refs
     */
    constructor(config, refs) {
        this.config = config || {};
        this.refs = refs;
        this.bus = new EventBus();
        this.store = new StateStore(this.config, this.bus);
    }

    /**
     * Build layout + renderer + interaction and paint. Called by the boot module once the
     * mount's child refs are in the DOM.
     */
    init() {
        // In-page init timing (M7 perf budgets): script time from layout to interactive, read
        // by the PerfBudgetTest — in-page so machine/CI wall-clock noise (network, Playwright
        // overhead) never pollutes the measurement.
        const initT0 = typeof performance !== 'undefined' ? performance.now() : 0;

        // Restore persisted operator layout (M7) BEFORE the first layout pass, so the initial
        // paint already uses the saved widths/hidden set — no visible re-layout flicker.
        this.layoutStore = new LayoutStore(this.store.layout.persist || null);
        const savedLayout = this.layoutStore.load(this.store.columns.map((c) => c.key));
        if (savedLayout) {
            this.store.widthOverrides = savedLayout.widths;
            this.store.userHidden = new Set(savedLayout.hidden);
        }

        this.applySizing();

        this.layout = new Layout(this.store, this.refs);
        this.layout.apply();

        this.renderer = new Renderer(this.store, this.layout, this.refs, this.bus);
        this.renderer.paint();

        this.setAriaGrid();

        // Interaction layer (M2). Selection is the command surface; the painter/announcer/
        // status bar are read-only subscribers; keyboard + clipboard drive it.
        this.selection = new SelectionManager(this.store, this.refs);
        this.painter = new SelectionPainter(this.store, this.renderer, this.bus, this.refs);
        this.announcer = this.refs.announcer
            ? new Announcer(this.store, this.bus, this.refs.announcer)
            : null;
        this.clipboard = new ClipboardManager(this.store, {
            announce: (msg) => this.announcer && this.announcer.message(msg),
        });
        this.statusBar =
            this.store.layout.statusBar && this.refs.statusbar
                ? new StatusBar(this.store, this.bus, this.refs.statusbar)
                : null;

        // The single layered popup (M5) now serves every mode: picker editors on editable
        // grids AND the M7 column chooser everywhere. Absent ref → both degrade to nothing.
        // Built BEFORE installEditing, which captures it into the picker bridge.
        this.popupManager = this.refs.popup ? new PopupManager(this.refs) : null;

        // Editing layer (M4): only an editable grid with a live $wire gets the editor/sync/error
        // stack. In-memory display + readonly grids skip it entirely (identical to M1/M2/M3).
        this.installEditing();

        // Row activation (readonly master lists): Enter/double-click on a row with an `_activateUrl`
        // dispatches `lgrid:activate` for the host to navigate. A no-op unless layout.rowActivate is
        // set; the double-click listener lives inside it, Enter is routed via the KeyboardManager
        // hook below (so the excel keymap's move-down still wins for a non-activatable row).
        this.rowActivator = new RowActivator(this.store, this.renderer, this.selection, this.refs);
        this.rowActivator.init();

        this.keyboard = new KeyboardManager(this.store, this.selection, this.refs, {
            actionsMenu: () => this.actionRunner && this.actionRunner.openMenu(),
            onCopy: () => this.clipboard.copy(),
            editor: this.editorManager || null,
            rowOps: this.rowOps || null,
            onRequiredBlock: (addr) => this.flashRequiredCell(addr),
            onComplete: () => this.dispatchComplete(),
            rowActivate: this.rowActivator.isEnabled() ? () => this.rowActivator.activate() : null,
        });

        // The complete-guard signal (layout.complete satisfied at the entry flow's end):
        // surface it to the HOST as a bubbling DOM event from the root — the mirror of the
        // host→client `lgrid:reseed` seam — so the host decides what "complete" does (the
        // voucher blade forwards focus to Save). Emitted by EditorManager.moveOrAppend (bus)
        // and the KeyboardManager blank-row Enter (hook above).
        this.offComplete = this.bus.on('grid:complete', () => this.dispatchComplete());

        // Host-panel hand-off (a column's opensPanel): the operator committed a cell whose column
        // hands its forward advance to a host panel (e.g. the item-line "Description" popup). Stash
        // the deferred advance and surface the request to the host as a bubbling `lgrid:panel` DOM
        // event; the host opens its modal and, when done, resumes us via `lgrid:panel-done`.
        this.pendingPanelAdvance = null;
        this.offPanel = this.bus.on('grid:panel', (d) => this.dispatchPanel(d));

        this.selection.init();
        this.keyboard.init();
        this.installFocusBehaviors();

        // A structural-failure rollback replaced the rows wholesale — tell the operator why.
        this.offRolledBack = this.bus.on('rows:rolled-back', ({ message }) => {
            if (this.announcer) {
                this.announcer.message(message);
            }
        });

        // Column drag-resize + autofit (M7): pure client geometry, active on every grid mode.
        this.resizeManager = new ResizeManager(this.store, this.layout, this.refs, this.bus, this.layoutStore);
        this.resizeManager.init();

        // Server-data layer (M3). Only a server-side grid with a live $wire proxy gets a PageSource
        // (sort/search/filter/paginate over gridFetch) + pagination chrome. In-memory grids skip it
        // entirely — identical behaviour to M1/M2.
        this.installServerData();

        // Package toolbar (P6) + the column chooser (M7): the chooser mounts into the toolbar's
        // slot when one renders, else floats at the grid's top-right exactly as before.
        this.installToolbar();

        // Universal host→client channels (every mode, P5): `lgrid:reseed` replaces the row set
        // wholesale — editable hosts fire it on save() exit paths, display hosts whenever their
        // data changes (reseedGrid(name, rows)). The empty-state repaint rides rows:changed in
        // every mode for the same reason.
        this.installReseed();
        this.offEmptyState = this.bus.on('rows:changed', () => this.renderEmptyState());
        this.renderEmptyState();

        this.installMorphGuard();

        /** Total init script time in ms (store build excluded — it runs in the constructor). */
        this.initMs = typeof performance !== 'undefined' ? performance.now() - initT0 : 0;
    }

    /**
     * Build the readonly server-data layer for a server-side grid: PageSource (the RPC/cache/stale
     * driver), the sort-click listener on header sort controls, the pagination chrome, and the
     * loading/empty state wiring. All optional refs absent → no-op.
     */
    installServerData() {
        if (!this.store.serverSide || !this.refs.wire) {
            return;
        }

        this.pageSource = new PageSource(this.store, this.bus, this.refs.wire);

        // Sort control clicks: a click on a header sort button re-sorts via PageSource, and stops
        // propagation so it does NOT also trigger M2 whole-column selection on the same header cell.
        this.onSortClick = (e) => {
            const sortBtn = e.target.closest('.lgrid-sort');
            if (sortBtn && this.refs.head.contains(sortBtn)) {
                e.preventDefault();
                e.stopPropagation();
                this.pageSource.sort(sortBtn.dataset.sort);
            }
        };
        // Capture phase so stopPropagation beats SelectionManager's pointerdown (column select).
        this.refs.head.addEventListener('pointerdown', this.onSortClick, true);

        if (this.refs.pagination) {
            this.pagination = new PaginationBar(this.store, this.bus, this.pageSource, this.refs.pagination);
            this.pagination.render();
        }

        // In-header filter menus (M7) for columns carrying an attached ->filterable() filter.
        if (this.popupManager) {
            this.headerFilters = new HeaderFilters(this.store, this.refs, this.popupManager, this.pageSource);
            this.headerFilters.init();
        }

        // Loading overlay reacts to fetches (empty state is wired mode-agnostically in init).
        this.bus.on('loading:changed', ({ loading }) => this.setLoading(loading));

        // Host-toolbar bridge: a host renders its own search/filter inputs (outside wire:ignore)
        // and dispatches `lgrid:toolbar` DOM events; we route the matching grid's ones to PageSource
        // so the host stays Livewire-free and never morphs the body. {grid, kind, key?, value}.
        this.onToolbar = (e) => {
            const d = e.detail || {};
            if (d.grid !== this.store.name) {
                return;
            }
            if (d.kind === 'search') {
                this.pageSource.search(d.value);
            } else if (d.kind === 'filter') {
                this.pageSource.setFilter(d.key, d.value);
            } else if (d.kind === 'perPage') {
                this.pageSource.setPerPage(Number(d.value));
            }
        };
        document.addEventListener('lgrid:toolbar', this.onToolbar);
    }

    /**
     * Build the editing layer for an editable grid: the SyncManager (op queue), the ClientValidator,
     * the EditorManager (floating editor + EDIT state machine), the ErrorPainter, and the row-op
     * handlers the KeyboardManager routes Insert/Delete/Ctrl+D to. All gated on an editable grid
     * with a live $wire — otherwise a no-op (in-memory display + readonly grids never construct it).
     */
    installEditing() {
        if (!this.store.editable || !this.refs.wire || !this.refs.editor) {
            return;
        }

        this.sync = new SyncManager(this.store, this.bus, this.refs.wire);
        this.validator = new ClientValidator();

        // The gridOptions bridge (M5 pickers) over the shared popup built in init(). Absent
        // popup just means picker editors degrade to nothing (never a crash).
        const wire = this.refs.wire;
        const picker = {
            popup: this.popupManager,
            // The RPC returns an {options: [...]} envelope; editors consume the bare list.
            search: (colKey, term, row) => wire
                .gridOptions(this.store.name, colKey, term, row)
                .then((response) => (response && response.options) || []),
        };

        this.editorManager = new EditorManager(
            this.store,
            this.renderer,
            this.selection,
            this.sync,
            this.validator,
            this.bus,
            this.refs,
            picker,
        );
        this.errorPainter = new ErrorPainter(this.store, this.renderer, this.bus, this.refs);

        // Open the editor on a double-click of an editable cell. Pad rows (Busy dedicated
        // blanks) are inert — without the guard the editor would open at the PREVIOUS active
        // cell, which reads as a misfire.
        this.onDblClick = (e) => {
            const cell = e.target.closest('.lgrid-cell');
            if (cell && this.refs.body.contains(cell) && !cell.closest('.lgrid-row--pad')) {
                this.editorManager.open({ caretAtEnd: true });
            }
        };
        this.refs.body.addEventListener('dblclick', this.onDblClick);

        // TSV paste (M5, G15): the grid root owns the paste event in NAV mode; while the editor
        // is open its input handles paste natively. R7: the paste EVENT is permission-free.
        this.onPaste = (e) => {
            if (this.editorManager.isEditing()) {
                return;
            }
            const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
            if (!text) {
                return;
            }
            e.preventDefault();
            this.clipboard.paste(text, {
                editor: this.editorManager,
                sync: this.sync,
                popup: this.popupManager,
                anchorCellEl: () => {
                    const active = this.store.active;
                    return active ? this.renderer.cellElFor(active.rowKey, active.colKey) : null;
                },
            });
        };
        this.refs.root.addEventListener('paste', this.onPaste);

        // Flush queued ops on the active-row change under the PerRow policy.
        this.offActiveRow = this.bus.on('active:changed', () => this.onActiveCellChanged());
        this.lastActiveRow = null;

        // Row ops (Insert/Delete/Ctrl+D) → optimistic store mutation + op enqueue.
        this.rowOps = {
            insert: () => this.rowInsert(),
            delete: () => this.rowDelete(),
            fillDown: () => this.rowFillDown(),
            clear: () => this.clearSelectedCells(),
        };

        // Footer live-total reconcile from op responses.
        this.offFooter = this.bus.on('footer:changed', ({ footer }) => this.applyFooter(footer));

        // Host→client panel resume: the host's panel (opened via our `lgrid:panel`) closed and
        // dispatched `lgrid:panel-done` {grid}. Re-focus the grid and run the deferred advance. A
        // Livewire dispatch(), so it fires on WINDOW like `lgrid:reseed`.
        this.onPanelDone = (e) => {
            const d = e.detail || {};
            if (d.grid !== this.store.name) {
                return;
            }
            this.resumeAfterPanel();
        };
        window.addEventListener('lgrid:panel-done', this.onPanelDone);
    }

    /**
     * Apply the declarative sizing chains (P6): ->height() fixes the root box (flex mode so the
     * pagination/status chrome keeps its place), ->maxHeight() re-caps the scroll box via the
     * --lgrid-max-h token, ->fillParent() fills a sized ancestor.
     */
    applySizing() {
        const sizing = this.store.layout.sizing;
        if (!sizing) {
            return;
        }
        if (sizing.height) {
            this.refs.root.style.height = sizing.height;
            this.refs.root.classList.add('lgrid--fill');
        }
        if (sizing.maxHeight && this.refs.scroll) {
            this.refs.scroll.style.setProperty('--lgrid-max-h', sizing.maxHeight);
        }
        if (sizing.fill) {
            this.refs.root.classList.add('lgrid--fill');
        }
    }

    /**
     * Build the package toolbar (P6) from layout.toolbar, then the column chooser — into the
     * toolbar's slot when it rendered one, else floating on the root (the pre-toolbar layout).
     */
    installToolbar() {
        // The action runner (P7) — built first so the toolbar can hand it its buttons. Exists
        // whenever the config declares ANY action scope.
        if (this.config.actions) {
            this.actionRunner = new ActionRunner(this.store, this.renderer, this.bus, this.refs, {
                wire: this.refs.wire || null,
                popup: this.popupManager,
                pageSource: this.pageSource || null,
                sync: this.sync || null,
                announcer: this.announcer,
                actions: this.config.actions,
            });
            this.actionRunner.init();
        }

        const spec = this.store.layout.toolbar;
        if (spec && this.refs.toolbar) {
            this.toolbar = new Toolbar(
                this.store,
                this.refs,
                this.pageSource || null,
                this.config.filters || [],
                this.bus,
                this.actionRunner || null,
                this.config.actions || {},
            );
            this.toolbar.render();
        }

        if (this.popupManager) {
            this.columnChooser = new ColumnChooser(this.store, this.refs, this.popupManager, this.layoutStore, {
                onChange: () => this.onColumnLayoutChanged(),
                container: (this.toolbar && this.toolbar.chooserSlot) || null,
            });
            // Suppressed chooser (toolbar declared it off) → skip entirely; a toolbar-less grid
            // (spec false/absent) keeps the classic floating button.
            if (!spec || spec.chooser) {
                this.columnChooser.init();
            }
        }
    }

    /**
     * The declarative focus chains (P6): ->focusOnMount() activates the first cell now;
     * ->focusOutTo() intercepts forward-Tab at the LAST navigable cell and sends focus to the
     * host's selector instead of the browser's natural next element. onCompleteFocus rides
     * dispatchComplete(); the reseed focus-return lives in installReseed.
     */
    installFocusBehaviors() {
        const focus = this.store.layout.focus || {};

        if (focus.onMount) {
            requestAnimationFrame(() => {
                this.selection.ensureActive();
                this.refs.root.focus();
            });
        }

        if (focus.outTo) {
            this.onFocusOutKey = (e) => {
                if (e.key !== 'Tab' || e.shiftKey || e.defaultPrevented) {
                    return;
                }
                if (this.editorManager && this.editorManager.isEditing()) {
                    return;
                }
                if (this.isAtLastNavigableCell()) {
                    e.preventDefault();
                    this.focusSelector(focus.outTo);
                }
            };
            this.refs.root.addEventListener('keydown', this.onFocusOutKey);
        }
    }

    /** Whether the active cell is the grid's last navigable cell (Tab would escape). */
    isAtLastNavigableCell() {
        const active = this.store.active;
        if (!active) {
            return false;
        }
        const rows = this.store.rowCount();
        const lastRow = rows > 0 ? this.store.rowAt(rows - 1) : null;
        if (!lastRow || lastRow._k !== active.rowKey) {
            return false;
        }
        const columns = this.store.visibleColumns().filter((c) => c.navigable !== false);
        const last = columns[columns.length - 1];
        return !!last && last.key === active.colKey;
    }

    /** Focus a host selector, retrying briefly (a button may re-enable a tick later). */
    focusSelector(selector, tries = 40) {
        const target = document.querySelector(selector);
        if (target && !target.disabled) {
            target.focus();
            return;
        }
        if (tries > 0) {
            setTimeout(() => this.focusSelector(selector, tries - 1), 50);
        }
    }

    /**
     * Clear the selected (or active) editable, unlocked cells — the Excel Delete (P6). Each
     * cell runs the shared paste pipeline with an empty value (parse → validate → optimistic
     * store write), then the whole clear flushes as ONE batch.
     */
    clearSelectedCells() {
        if (!this.editorManager || !this.sync) {
            return;
        }
        const cells = this.store.selectedCells();
        const items = [];
        let cleared = 0;
        for (const { rowKey, colKey } of cells) {
            const column = this.store.columnByKey(colKey);
            if (!column || !column.editable || this.store.cellLocked(rowKey, colKey)) {
                continue;
            }
            const result = this.editorManager.pasteCell(rowKey, colKey, column, '');
            if (result.ok && result.op) {
                items.push({ op: result.op, cells: result.cells || [] });
                cleared += 1;
            }
        }
        if (items.length) {
            this.sync.enqueueBatch(items);
        }
        if (this.announcer && cleared) {
            this.announcer.message(cleared === 1 ? 'Cell cleared.' : cleared + ' cells cleared.');
        }
    }

    /**
     * Host→client reseed — EVERY mode (P5). The host mutated its rows outside the op protocol
     * (an editable save() exit path, or a display grid's data source changing) and dispatched
     * `lgrid:reseed` {grid, rows, footer} (a Livewire dispatch(), so it fires on WINDOW).
     * Close the editor/popup first (they hold cell references into the old rows), drop the op
     * queue (a reseed supersedes the rows those ops describe), then replace the store's rows
     * wholesale and repaint the footer totals — the editing-only managers are simply absent on
     * a display grid, hence the guards.
     */
    installReseed() {
        this.onReseed = (e) => {
            const d = e.detail || {};
            if (d.grid !== this.store.name || !Array.isArray(d.rows)) {
                return;
            }
            const hadFocus = this.refs.root.contains(document.activeElement);
            if (this.editorManager && this.editorManager.isEditing()) {
                this.editorManager.cancel();
            }
            if (this.popupManager && this.popupManager.isOpen()) {
                this.popupManager.close('owner');
            }
            if (this.sync) {
                this.sync.reset();
            }
            this.store.reseed(d.rows);
            this.applyFooter(d.footer || {});
            if (hadFocus) {
                // Focus-return: the reseed replaced the DOM under the operator's cursor —
                // restore the grid's focus so NAV keys keep working (never steals focus
                // from elsewhere on a background data refresh).
                this.refs.root.focus();
            }
        };
        window.addEventListener('lgrid:reseed', this.onReseed);
    }

    /**
     * Announce the complete-guard firing to the host: a bubbling `lgrid:complete` CustomEvent
     * from the grid root ({grid} detail, so a page with several grids can discriminate). The
     * grid keeps its active cell — whether focus leaves (and to where) is the host's decision.
     */
    dispatchComplete() {
        this.refs.root.dispatchEvent(new CustomEvent('lgrid:complete', {
            bubbles: true,
            detail: { grid: this.store.name },
        }));

        // Declarative complete-focus (P6): the packaged version of the host blade's old
        // retry-loop — a Save button disabled until this very commit re-enables mid-retry.
        const focus = this.store.layout.focus || {};
        if (focus.complete) {
            this.focusSelector(focus.complete);
        }
    }

    /**
     * Hand this cell's forward advance off to a HOST panel (a column's opensPanel). Stash the
     * deferred advance, then announce it to the host as a bubbling `lgrid:panel` CustomEvent
     * ({grid, panel, rowKey} detail, so a page with several grids/panels can discriminate). The
     * host opens its modal and resumes the grid via `lgrid:panel-done`; the advance runs then. The
     * grid keeps its active cell in the meantime, so the resume lands the cursor correctly.
     *
     * @param {{panel: string, rowKey: string, advance: string}} d
     */
    dispatchPanel(d) {
        this.pendingPanelAdvance = d.advance;
        this.refs.root.dispatchEvent(new CustomEvent('lgrid:panel', {
            bubbles: true,
            detail: { grid: this.store.name, panel: d.panel, rowKey: d.rowKey },
        }));
    }

    /**
     * Resume the grid after a host panel closes (`lgrid:panel-done` for THIS grid): re-focus the
     * grid root (so NAV keys resume) and run the advance the panel deferred. Always advances — the
     * panel's fields are optional, so a cancel (Esc / click-away) still moves the cursor forward,
     * exactly as the plain Enter would have. A no-op if nothing was pending (defensive).
     */
    resumeAfterPanel() {
        const advance = this.pendingPanelAdvance;
        this.pendingPanelAdvance = null;
        this.refs.root.focus();
        if (advance && this.editorManager) {
            this.editorManager.advance(advance);
        }
    }

    /**
     * The single relayout path after an operator column-layout change (hide/show, reset):
     * geometry (template var + frozen offsets + modifier classes), a full repaint (visibility
     * is structural — header/body/footer all change shape), and the ARIA counts.
     */
    onColumnLayoutChanged() {
        this.layout.apply();
        this.renderer.paint();
        this.setAriaGrid();
    }

    /** Under PerRow sync, flush the queue when the active cell moves to a different row. */
    onActiveCellChanged() {
        const active = this.store.active;
        const row = active ? active.rowKey : null;
        if (this.lastActiveRow !== null && row !== this.lastActiveRow && this.sync) {
            this.sync.onActiveRowChanged();
        }
        this.lastActiveRow = row;
    }

    /** Insert a blank row after the active row (Insert key). */
    rowInsert() {
        const after = this.store.active ? this.store.active.rowKey : null;
        const newKey = 'r' + this.store.nextSeq() + Math.random().toString(36).slice(2, 6);
        this.store.insertRow(newKey, after);
        this.sync.enqueue(
            { seq: this.store.nextSeq(), t: 'insert', after, as: newKey },
            [],
            { flush: true },
        );
    }

    /** Delete the active row (Shift+Delete / F7) — pre-checked against minRows (P6). */
    rowDelete() {
        const active = this.store.active;
        if (!active) {
            return;
        }
        const rowKey = active.rowKey;

        // Client mirror of the server's minRows guard: refuse BEFORE the optimistic removal,
        // so a refusal never desyncs the row structure (the server guard stays authoritative —
        // its structural rollback covers any race).
        const minRows = this.store.layout.minRows || 0;
        if (minRows > 0) {
            const blankTarget = this.store.rowIsBlankByKey(rowKey);
            const remaining = this.store.nonBlankRowCount() - (blankTarget ? 0 : 1);
            if (remaining < minRows) {
                if (this.announcer) {
                    this.announcer.message('At least ' + minRows + ' line(s) required.');
                }
                return;
            }
        }

        this.store.removeRow(rowKey);
        this.sync.enqueue({ seq: this.store.nextSeq(), t: 'remove', row: rowKey }, [], { flush: true });
    }

    /** Fill the active cell's column down across the current selection (Ctrl+D). */
    rowFillDown() {
        const sel = this.store.selection;
        const active = this.store.active;
        if (!active) {
            return;
        }
        const colKey = active.colKey;
        // Collect the row keys spanned by the selection (or just the active row → no-op).
        const r0 = sel ? sel.r0 : this.store.rowIndexOf(active.rowKey);
        const r1 = sel ? sel.r1 : r0;
        const rowKeys = [];
        for (let r = r0; r <= r1; r++) {
            const row = this.store.rowAt(r);
            if (row) {
                rowKeys.push(row._k);
            }
        }
        if (rowKeys.length < 2) {
            return;
        }
        this.store.fillDown(colKey, rowKeys);
        this.sync.enqueue(
            { seq: this.store.nextSeq(), t: 'fill', col: colKey, rows: rowKeys },
            rowKeys.slice(1).map((rowKey) => ({ rowKey, colKey })),
            { flush: true },
        );
    }

    /**
     * Flash a blank-required cell whose Enter-advance was blocked (entry keymap, G7 — the
     * form-kit red-flash parity) and announce it for AT. The class restarts its animation on
     * consecutive blocks and is dropped after it plays out.
     */
    flashRequiredCell(addr) {
        const cell = this.renderer ? this.renderer.cellElFor(addr.rowKey, addr.colKey) : null;
        if (cell) {
            cell.classList.remove('lgrid-cell--blocked');
            void cell.offsetWidth; // restart the animation when blocked repeatedly
            cell.classList.add('lgrid-cell--blocked');
            setTimeout(() => cell.classList.remove('lgrid-cell--blocked'), 450);
        }
        if (this.announcer) {
            const column = this.store.columnByKey(addr.colKey);
            this.announcer.message(`${(column && column.label) || addr.colKey} is required.`);
        }
    }

    /** Apply reconciled footer totals from an op response to the footer chrome. */
    applyFooter(footer) {
        this.store.pageTotals = footer || {};
        if (this.renderer) {
            this.renderer.footer.render();
        }
    }

    /** Force-flush queued ops (host calls this before save() under SyncPolicy::Deferred). */
    flush() {
        if (this.sync) {
            return this.sync.flush();
        }
    }

    /** Toggle the loading overlay (server fetch in flight). */
    setLoading(on) {
        if (this.refs.loading) {
            this.refs.loading.hidden = !on;
        }
        this.refs.root.classList.toggle('lgrid--loading', !!on);
    }

    /** Show/hide the empty-state message from the mount's <template> when there are zero rows. */
    renderEmptyState() {
        const tpl = this.refs.emptyTemplate;
        const hasRows = this.store.rowCount() > 0;
        this.refs.root.classList.toggle('lgrid--empty', !hasRows);
        // Clone the <template> content once, on first empty, and insert after the body.
        if (!this.emptyEl && tpl && 'content' in tpl && tpl.content.firstElementChild) {
            this.emptyEl = tpl.content.firstElementChild.cloneNode(true);
            // ->emptyState() chain overrides the template's default text (P6).
            if (this.store.layout.emptyState) {
                this.emptyEl.textContent = this.store.layout.emptyState;
            }
            this.refs.body.after(this.emptyEl);
        }
        if (this.emptyEl) {
            this.emptyEl.hidden = hasRows;
        }
    }

    /** Stamp the ARIA grid roles/counts on the root (rows/cells are stamped by BodyRenderer). */
    setAriaGrid() {
        const root = this.refs.root;
        root.setAttribute('role', 'grid');
        root.setAttribute('aria-readonly', this.store.editable ? 'false' : 'true');
        // aria-rowcount reflects the WHOLE set for a paginated grid (total + header), so assistive
        // tech announces "row X of total" across pages; +1 for the header row. In-memory grids use
        // the loaded row count.
        const totalRows = this.store.serverSide ? this.store.serverMeta.total : this.store.rowCount();
        root.setAttribute('aria-rowcount', String(totalRows + 1));
        root.setAttribute('aria-colcount', String(this.store.visibleColumns().length));
    }

    /**
     * Dev-only guard: the body lives inside `wire:ignore` and must be mutated ONLY by our
     * renderer. The observer is DISCONNECTED around our own body renders (body:will-render →
     * disconnect; body:did-render → drop our pending records, reconnect), so anything it observes
     * while connected is an external mutation — a Livewire morph leaking into sovereign territory
     * (R3). Stripped from production builds (import.meta.env.DEV is statically false in prod, so
     * the whole block is dead-code-eliminated).
     */
    installMorphGuard() {
        if (typeof import.meta === 'undefined' || !import.meta.env || !import.meta.env.DEV) {
            return;
        }
        const opts = { childList: true, subtree: true, characterData: true };
        this.morphObserver = new MutationObserver((records) => {
            // eslint-disable-next-line no-console
            console.error(
                `[uf-datagrid:${this.store.name}] body DOM mutated outside a render pass — a Livewire morph may have leaked into the wire:ignore region (R3).`,
                records,
            );
        });
        this.bus.on('body:will-render', () => this.morphObserver.disconnect());
        this.bus.on('body:did-render', () => {
            this.morphObserver.takeRecords(); // discard our own paint's mutations
            this.morphObserver.observe(this.refs.body, opts);
        });
        this.morphObserver.observe(this.refs.body, opts);
    }

    /** Tear down subscriptions + listeners (mount removal, observed by the boot module). */
    destroy() {
        if (this.morphObserver) {
            this.morphObserver.disconnect();
        }
        if (this.onDblClick) {
            this.refs.body.removeEventListener('dblclick', this.onDblClick);
        }
        if (this.onPaste) {
            this.refs.root.removeEventListener('paste', this.onPaste);
        }
        if (this.popupManager) {
            this.popupManager.destroy();
        }
        if (this.offActiveRow) {
            this.offActiveRow();
        }
        if (this.offFooter) {
            this.offFooter();
        }
        if (this.offComplete) {
            this.offComplete();
        }
        if (this.offEmptyState) {
            this.offEmptyState();
        }
        if (this.offRolledBack) {
            this.offRolledBack();
        }
        if (this.onFocusOutKey) {
            this.refs.root.removeEventListener('keydown', this.onFocusOutKey);
        }
        if (this.toolbar) {
            this.toolbar.destroy();
        }
        if (this.actionRunner) {
            this.actionRunner.destroy();
        }
        if (this.offPanel) {
            this.offPanel();
        }
        if (this.editorManager) {
            this.editorManager.destroy();
        }
        if (this.errorPainter) {
            this.errorPainter.destroy();
        }
        if (this.sync) {
            this.sync.destroy();
        }
        if (this.onSortClick) {
            this.refs.head.removeEventListener('pointerdown', this.onSortClick, true);
        }
        if (this.onToolbar) {
            document.removeEventListener('lgrid:toolbar', this.onToolbar);
        }
        if (this.onReseed) {
            window.removeEventListener('lgrid:reseed', this.onReseed);
        }
        if (this.onPanelDone) {
            window.removeEventListener('lgrid:panel-done', this.onPanelDone);
        }
        if (this.pagination) {
            this.pagination.destroy();
        }
        if (this.pageSource) {
            this.pageSource.destroy();
        }
        if (this.headerFilters) {
            this.headerFilters.destroy();
        }
        if (this.columnChooser) {
            this.columnChooser.destroy();
        }
        if (this.resizeManager) {
            this.resizeManager.destroy();
        }
        if (this.keyboard) {
            this.keyboard.destroy();
        }
        if (this.rowActivator) {
            this.rowActivator.destroy();
        }
        if (this.selection) {
            this.selection.destroy();
        }
        if (this.painter) {
            this.painter.destroy();
        }
        if (this.statusBar) {
            this.statusBar.destroy();
        }
        if (this.announcer) {
            this.announcer.destroy();
        }
        if (this.renderer) {
            this.renderer.destroy();
        }
        if (this.layout) {
            this.layout.destroy();
        }
        this.bus.clear();
    }
}
