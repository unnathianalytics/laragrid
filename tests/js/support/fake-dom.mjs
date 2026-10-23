/**
 * A minimal DOM stand-in for the renderer runners (no jsdom): enough of Element for
 * BodyRenderer's build / insert / remove paths and the painters' class and attribute writes.
 * Parent links are tracked so insertBefore/removeChild/remove behave like the real thing.
 */
export class FakeElement {
    constructor(tag = 'div', fragment = false) {
        this.tagName = tag;
        this.fragment = fragment;
        this.children = [];
        this.parentNode = null;
        this.dataset = {};
        this.style = {};
        this.attributes = new Map();
        this._text = '';
        this.id = '';
        this.hidden = false;
        this.classes = new Set();
        this.classList = {
            add: (...names) => names.forEach((name) => this.classes.add(name)),
            remove: (...names) => names.forEach((name) => this.classes.delete(name)),
            toggle: (name, on) => {
                if (on === undefined) {
                    on = !this.classes.has(name);
                }
                if (on) this.classes.add(name); else this.classes.delete(name);
                return on;
            },
            contains: (name) => this.classes.has(name),
        };
    }

    set className(value) {
        this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    }

    get className() { return [...this.classes].join(' '); }

    set textContent(value) {
        this._text = String(value ?? '');
        if (this._text === '') {
            this.children.forEach((child) => { child.parentNode = null; });
            this.children = [];
        }
    }

    get textContent() { return this._text; }

    get firstChild() { return this.children[0] || null; }

    adopt(child) {
        if (child.fragment) {
            const kids = child.children.splice(0);
            kids.forEach((kid) => { kid.parentNode = this; });
            return kids;
        }
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        return [child];
    }

    appendChild(child) {
        this.children.push(...this.adopt(child));
        return child;
    }

    insertBefore(child, ref) {
        if (!ref) return this.appendChild(child);
        const kids = this.adopt(child);
        const at = this.children.indexOf(ref);
        if (at < 0) throw new Error('insertBefore: reference node is not a child');
        this.children.splice(at, 0, ...kids);
        return child;
    }

    removeChild(child) {
        const at = this.children.indexOf(child);
        if (at < 0) throw new Error('removeChild: not a child');
        this.children.splice(at, 1);
        child.parentNode = null;
        return child;
    }

    remove() { if (this.parentNode) this.parentNode.removeChild(this); }

    after(node) {
        if (this.parentNode) {
            const at = this.parentNode.children.indexOf(this);
            this.parentNode.children.splice(at + 1, 0, ...this.parentNode.adopt(node));
        }
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }

    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }

    removeAttribute(name) { this.attributes.delete(name); }

    addEventListener() {}

    removeEventListener() {}

    dispatchEvent() { return true; }

    closest() { return null; }

    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
}

/**
 * Install document / window / getComputedStyle globals backed by FakeElement. Returns a
 * restore() function and a `reads` counter for getComputedStyle calls.
 */
export function installFakeDom({ rowHeight = '1.5rem', fontSize = '16px' } = {}) {
    const previous = {
        document: globalThis.document,
        window: globalThis.window,
        getComputedStyle: globalThis.getComputedStyle,
    };
    const state = { reads: 0 };
    globalThis.document = {
        documentElement: new FakeElement('html'),
        createElement: (tag) => new FakeElement(tag),
        createDocumentFragment: () => new FakeElement('fragment', true),
        getElementById: () => null,
        addEventListener() {},
        removeEventListener() {},
    };
    globalThis.window = { addEventListener() {}, removeEventListener() {} };
    globalThis.getComputedStyle = () => {
        state.reads += 1;
        return { getPropertyValue: () => rowHeight, fontSize };
    };
    state.restore = () => {
        globalThis.document = previous.document;
        globalThis.window = previous.window;
        globalThis.getComputedStyle = previous.getComputedStyle;
    };
    return state;
}
