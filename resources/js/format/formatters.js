/**
 * LaraGrid — client formatter registry (the JS half of the R2 anti-drift pair).
 *
 * What: Named display formatters — text / number / date in core — mirroring the PHP
 *       formatters in src/Formatting/Formatters/*, plus registerFormatter(): the seam a
 *       consuming app uses to add its own names (each MUST mirror a PHP Formatter it
 *       registered under the same name, pinned by a shared JSON vector).
 * Why:  Formatting is the ONE layer implemented in both runtimes (plan §2.5, R2). The PHP
 *       side is authoritative, asserted over tests/fixtures/grid-vectors/formats.json; this
 *       port satisfies the same vectors so the numbers agree by construction. Client output
 *       is purely cosmetic — server values always win.
 * When: Imported by CellPainters (per-cell display), FooterRenderer (footer totals) and the
 *       StatusBar; extended at boot via window.LaraGrid.registerFormatter.
 *
 * NOTE: `args` may arrive as {} or as [] (PHP serializes an empty assoc array as a JSON
 *       array), so every accessor reads defensively via `arg()`.
 */

/**
 * Read an arg with a fallback, tolerating args being an array or object (or null).
 */
function arg(args, key, fallback) {
    if (args == null) {
        return fallback;
    }
    const value = args[key];
    return value === undefined ? fallback : value;
}

/** Fixed-scale round-half-up formatter returning a plain (ungrouped) decimal string. */
function toFixedString(value, scale) {
    // Number.prototype.toFixed rounds half-to-even in some engines for edge cases; the
    // grid's values are within safe-integer range for money and small quantities, where
    // toFixed matches PHP's round(half-up). Kept simple deliberately (plan: cosmetic).
    return Number(value).toFixed(scale);
}

/** Coerce to a display string, null/'' → ''. */
function textFormatter(value, args) {
    if (value === null || value === undefined) {
        return '';
    }
    let text = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value);
    const transform = arg(args, 'transform', null);
    if (transform === 'upper') {
        text = text.toUpperCase();
    } else if (transform === 'lower') {
        text = text.toLowerCase();
    }
    return text;
}

/** Locale-neutral fixed-scale number with optional plain thousands grouping. */
function numberFormatter(value, args) {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    const scale = Math.max(0, parseInt(arg(args, 'scale', 0), 10) || 0);
    const group = arg(args, 'group', true);

    const fixed = toFixedString(value, scale);
    const negative = fixed.startsWith('-');
    const abs = negative ? fixed.slice(1) : fixed;
    const [intPart, fracPart] = scale > 0 ? abs.split('.') : [abs, ''];

    const grouped = group ? intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : intPart;

    return (negative ? '-' : '') + grouped + (scale > 0 ? '.' + fracPart : '');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Generic date formatter — parses an ISO/Y-m-d value and renders it in a display pattern.
 * Supports the common PHP date() tokens: d, m, Y, M. Falls back to the raw string when the
 * value isn't a parseable date (never throws — display must not break paint).
 */
function dateFormatter(value, args) {
    if (value === null || value === undefined || value === '') {
        return '';
    }
    const display = String(arg(args, 'display', 'd-m-Y'));

    // Parse date-only strings without timezone drift by pinning to the Y-m-d parts.
    const raw = String(value);
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    let year;
    let month;
    let day;
    if (m) {
        year = Number(m[1]);
        month = Number(m[2]);
        day = Number(m[3]);
    } else {
        const parsed = new Date(raw);
        if (Number.isNaN(parsed.getTime())) {
            return raw;
        }
        year = parsed.getFullYear();
        month = parsed.getMonth() + 1;
        day = parsed.getDate();
    }

    const pad2 = (n) => String(n).padStart(2, '0');

    return display.replace(/d|m|M|Y/g, (token) => {
        switch (token) {
            case 'd':
                return pad2(day);
            case 'm':
                return pad2(month);
            case 'M':
                return MONTHS[month - 1] || '';
            case 'Y':
                return String(year);
            default:
                return token;
        }
    });
}

const FORMATTERS = {
    text: textFormatter,
    number: numberFormatter,
    date: dateFormatter,
};

/**
 * Register (or override) a named client formatter — the JS twin of
 * FormatRegistry::register(). `fn(value, args) => string`. An app that registers a PHP
 * formatter (e.g. 'inr') MUST register the matching name here so cells, footers and the
 * status bar all paint through it; pin the pair with a shared JSON vector.
 */
export function registerFormatter(name, fn) {
    FORMATTERS[name] = fn;
}

/**
 * Format a raw value through a {name, args} format tag (as serialized by PHP's Format).
 * A missing or unknown format falls back to the generic text formatter.
 *
 * @param {{name: string, args?: object}|null} format
 * @param {*} value
 * @returns {string}
 */
export function formatValue(format, value) {
    if (!format || !format.name) {
        return textFormatter(value, {});
    }
    const fn = FORMATTERS[format.name] || textFormatter;
    return fn(value, format.args || {});
}

export { textFormatter, numberFormatter, dateFormatter };
