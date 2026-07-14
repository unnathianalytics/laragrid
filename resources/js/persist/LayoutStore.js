/**
 * What: The layout-persistence adapter (M7, umbrella G9 v1) — saves and restores operator
 *       layout state (column width overrides + hidden columns) in localStorage under one
 *       schema-versioned entry per grid: `lgrid:{key}` → {v, widths, hidden}.
 * Why:  Persistence must never be able to BREAK a grid: every read is try/caught, the schema
 *       version gates the shape (a bump invalidates stale entries wholesale), and unknown
 *       column keys are dropped on load so a definition change can't resurrect a width for a
 *       column that no longer exists (plan R-persist-poison). It is an injected adapter — the
 *       reserved G9 'server' mode replaces this class behind the same three methods, nothing
 *       else changes.
 * When: Constructed by GridCore from the config's layout.persist (absent → disabled no-op);
 *       read once before first layout, written by ResizeManager / the column chooser.
 */
const SCHEMA_VERSION = 1;

export default class LayoutStore {
    /**
     * @param {{mode: string, key: string}|null} persist the serialized layout.persist fragment
     */
    constructor(persist) {
        this.key = persist && persist.mode === 'local' && persist.key ? `lgrid:${persist.key}` : null;
    }

    /** Whether this grid persists layout at all. */
    enabled() {
        return this.key !== null;
    }

    /**
     * Load the persisted layout state, validated against the grid's real column keys.
     * @param {string[]} validKeys the definition's column keys — anything else is dropped
     * @returns {{widths: Object<string, number>, hidden: string[]}|null} null when disabled,
     *          absent, corrupt, or from another schema version
     */
    load(validKeys) {
        if (!this.key) {
            return null;
        }
        try {
            const raw = window.localStorage.getItem(this.key);
            if (!raw) {
                return null;
            }
            const data = JSON.parse(raw);
            if (!data || data.v !== SCHEMA_VERSION) {
                return null;
            }
            const widths = {};
            for (const [colKey, width] of Object.entries(data.widths || {})) {
                if (validKeys.includes(colKey) && Number.isFinite(width) && width > 0) {
                    widths[colKey] = Math.round(width);
                }
            }
            const hidden = (Array.isArray(data.hidden) ? data.hidden : []).filter((colKey) =>
                validKeys.includes(colKey),
            );
            return { widths, hidden };
        } catch {
            return null; // corrupt entry — behave as if nothing was persisted
        }
    }

    /**
     * Persist the current layout state (whole-entry write; quota/privacy failures are silent —
     * persistence is a convenience, never a requirement).
     * @param {Object<string, number>} widths column width overrides by key
     * @param {string[]} hidden hidden column keys
     */
    save(widths, hidden) {
        if (!this.key) {
            return;
        }
        try {
            window.localStorage.setItem(
                this.key,
                JSON.stringify({ v: SCHEMA_VERSION, widths: widths || {}, hidden: hidden || [] }),
            );
        } catch {
            // storage full / blocked — drop silently
        }
    }

    /** Clear the persisted entry (the column chooser's "Reset layout"). */
    reset() {
        if (!this.key) {
            return;
        }
        try {
            window.localStorage.removeItem(this.key);
        } catch {
            // ignore
        }
    }
}
