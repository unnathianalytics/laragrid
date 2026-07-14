/**
 * What: A tiny internal publish/subscribe bus.
 * Why:  The subsystems (store, renderer, and — from M2 — keyboard/selection/editor) must
 *       talk without reaching into each other. In M1 the surface is deliberately minimal:
 *       the StateStore emits change notifications the Renderer subscribes to. Shipping the
 *       seam now (rather than a direct callback) keeps the M2+ modules bolting on without a
 *       rewrite, exactly as the plan's "small modules, hard edges" principle requires.
 * When: Instantiated once per grid by GridCore and shared with the store/renderer.
 */
export default class EventBus {
    constructor() {
        /** @type {Map<string, Set<Function>>} */
        this.listeners = new Map();
    }

    /**
     * Subscribe to an event; returns an unsubscribe function.
     * @param {string} event
     * @param {Function} handler
     * @returns {() => void}
     */
    on(event, handler) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(handler);
        return () => this.off(event, handler);
    }

    /**
     * @param {string} event
     * @param {Function} handler
     */
    off(event, handler) {
        const set = this.listeners.get(event);
        if (set) {
            set.delete(handler);
        }
    }

    /**
     * @param {string} event
     * @param {*} [payload]
     */
    emit(event, payload) {
        const set = this.listeners.get(event);
        if (!set) {
            return;
        }
        for (const handler of [...set]) {
            handler(payload);
        }
    }

    /** Drop all listeners (grid teardown). */
    clear() {
        this.listeners.clear();
    }
}
