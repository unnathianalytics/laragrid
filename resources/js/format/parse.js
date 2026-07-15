/**
 * LaraGrid — client cast registry (the JS half of the cast pair with the PHP CastRegistry).
 *
 * What: Turn an operator's typed text into the column's model value per its `parse` spec kind —
 *       core kinds text / int / decimal(scale) / select / bool / date, plus registerCast(): the
 *       seam a consuming app uses to add its own kinds (each MUST mirror a PHP Cast it
 *       registered under the same kind). Also owns editTextFor(): the canonical
 *       EDITING/interchange text for a model value (what F2 preserves, what an editable copy
 *       emits, what a paste round-trips) — a registered cast supplies its own via `editText`.
 * Why:  An edit applies optimistically on the client (instant paint) and is re-cast
 *       authoritatively on the server; the two must agree by construction (plan §2.5, R2). This
 *       module mirrors LaraGrid\Casting — same kinds, same rounding (half-up at scale), same
 *       grouping-strip — so the optimistic value and the server write-back match and no cell
 *       "flickers" on reconcile. The DATE kind resolves fuzzy typed text through the ONE shared
 *       parser (shared/date.js) to canonical ISO, so no second fuzzy parser exists anywhere —
 *       an unparseable non-empty date returns the `undefined` sentinel so the editor can refuse
 *       the commit. Unknown kinds fall back to text in BOTH runtimes.
 * When: Called by the editors' commit pipeline (and paste) before the value enters the
 *       StateStore + the op; extended at boot via window.LaraGrid.registerCast.
 */
import { parseFreeform, partsFromValue, formatIso, formatDisplay } from '../shared/date.js';

/** Strip grouping commas and spaces from a numeric string. */
export function stripGrouping(raw) {
    return String(raw == null ? '' : raw).replace(/[,\s]/g, '');
}

/** Round half-up at `scale` decimals (mirrors PHP round(..., HALF_UP)). */
export function roundHalfUp(value, scale) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const factor = Math.pow(10, scale);
    // + a tiny epsilon guards binary-fp cases like 1.005 the same way PHP's half-up does for
    // the grid's value range (money / small quantities), keeping the two runtimes in agreement.
    const shifted = value * factor;
    const rounded = Math.sign(shifted) * Math.round(Math.abs(shifted) + 1e-9);
    return rounded / factor;
}

/** Parse trimmed text, applying an optional case transform ('upper'|'lower'). */
export function parseText(raw, transform) {
    let text = raw == null ? '' : String(raw).trim();
    if (transform === 'upper') {
        text = text.toUpperCase();
    } else if (transform === 'lower') {
        text = text.toLowerCase();
    }
    return text;
}

/** Parse to a whole number (grouping stripped, rounded to an integer). Blank/invalid → 0. */
export function parseInt10(raw) {
    const normalised = stripGrouping(raw);
    if (normalised === '' || Number.isNaN(Number(normalised))) {
        return 0;
    }
    return Math.round(Number(normalised));
}

/**
 * Parse to a fixed-scale decimal STRING (rounded half-up at scale), so precision never rides a
 * float (plan G2). Mirrors LaraGrid\Casting\Casts\DecimalCast.
 */
export function parseDecimal(raw, scale) {
    const normalised = stripGrouping(raw);
    const number = normalised === '' || Number.isNaN(Number(normalised)) ? 0 : Number(normalised);
    return roundHalfUp(number, scale).toFixed(scale);
}

/**
 * Parse a picker value: an opaque option id — trimmed string, blank → null (a cleared pick).
 * Mirrors LaraGrid\Casting\Casts\SelectCast.
 */
export function parseSelect(raw) {
    const text = raw == null ? '' : String(raw).trim();
    return text === '' ? null : text;
}

/**
 * Parse a checkbox value to a real boolean. Mirrors LaraGrid\Casting\Casts\BoolCast (PHP's
 * FILTER_VALIDATE_BOOLEAN truthy set): true/'1'/'true'/'on'/'yes' → true; everything else false.
 */
export function parseBool(raw) {
    if (raw === true) {
        return true;
    }
    const text = String(raw == null ? '' : raw).trim().toLowerCase();
    return ['1', 'true', 'on', 'yes'].includes(text);
}

/**
 * Parse a Y/N value to a real boolean: the checkbox truthy set PLUS 'y' — the letter the operator
 * actually types on a YesNoColumn. Mirrors LaraGrid\Casting\Casts\YnCast (a distinct kind rather
 * than a widened 'bool', so checkbox semantics — pinned to PHP's FILTER_VALIDATE_BOOLEAN — stay
 * untouched). Everything unrecognised → false, same discipline as parseBool.
 */
export function parseYn(raw) {
    if (raw === true) {
        return true;
    }
    const text = String(raw == null ? '' : raw).trim().toLowerCase();
    return ['y', 'yes', '1', 'true', 'on'].includes(text);
}

/**
 * Parse typed date text to canonical ISO `Y-m-d` via the SHARED fuzzy parser: blank → null
 * (cleared); an already-canonical ISO / display-pattern value passes through re-canonicalised;
 * fuzzy text (`31/12`, `311226`, `2-1`) resolves a missing year against the column's
 * financial-year window WHEN the spec carries one (DateColumn ->financialYear() /
 * config laragrid.date.fy_start_month), else against the plain calendar year — the neutral
 * default. Unparseable non-empty text → the `undefined` SENTINEL — the one parse outcome that
 * means "refuse the commit", which the DateEditor turns into a cell error instead of a value.
 *
 * @param {*} raw
 * @param {{fyStartMonth?: number, fyStartYear?: number}} spec
 * @returns {string|null|undefined}
 */
export function parseDate(raw, spec) {
    const text = raw == null ? '' : String(raw).trim();
    if (text === '') {
        return null;
    }

    const direct = partsFromValue(text);
    if (direct) {
        return formatIso(direct);
    }

    // No FY declared → a January window, i.e. plain calendar-year inference.
    const parts = parseFreeform(
        text,
        Number(spec && spec.fyStartMonth) || 1,
        Number(spec && spec.fyStartYear) || new Date().getFullYear(),
    );
    return parts ? formatIso(parts) : undefined;
}

/**
 * The cast registry: kind → {parse(raw, spec), editText?(value, spec)}. Core kinds mirror
 * LaraGrid\Casting\CastRegistry; registerCast() adds app kinds (e.g. an accounting app's
 * 'paise'). `editText` is optional — kinds whose model value isn't its own editing text
 * (dates, booleans, scaled money) supply one; others fall back to String(value).
 */
const CASTS = {
    text: {
        parse: (raw, spec) => parseText(raw, spec ? spec.case : null),
    },
    int: {
        parse: (raw) => parseInt10(raw),
    },
    decimal: {
        parse: (raw, spec) => parseDecimal(raw, Math.max(0, parseInt(spec && spec.scale, 10) || 0)),
    },
    select: {
        parse: (raw) => parseSelect(raw),
    },
    bool: {
        parse: (raw) => parseBool(raw),
        editText: (value) => (parseBool(value) ? '1' : '0'),
    },
    yn: {
        parse: (raw) => parseYn(raw),
        editText: (value) => (parseYn(value) ? 'Y' : 'N'),
    },
    date: {
        parse: (raw, spec) => parseDate(raw, spec || {}),
        editText: (value) => {
            const parts = partsFromValue(String(value));
            return parts ? formatDisplay(parts) : '';
        },
    },
};

/**
 * Register (or override) a parse kind — the JS twin of CastRegistry::register(). An app that
 * registers a PHP Cast (e.g. 'paise') MUST register the matching kind here so the optimistic
 * client value agrees with the authoritative server cast; pin the pair with a shared vector.
 *
 * @param {string} kind
 * @param {{parse: (raw: *, spec: object) => *, editText?: (value: *, spec: object) => string}} cast
 */
export function registerCast(kind, cast) {
    CASTS[kind] = cast;
}

/**
 * Parse a raw typed value through a column's `parse` spec tag (as serialized by PHP).
 * Unknown kinds fall back to the text cast — mirroring the PHP registry's fallback.
 *
 * @param {{kind: string, scale?: number, case?: string|null, fyStartMonth?: number, fyStartYear?: number}|null|undefined} spec
 * @param {*} raw the operator's typed text
 * @returns {*} `undefined` ONLY for an unparseable date-like refusal
 */
export function parseValue(spec, raw) {
    const kind = (spec && spec.kind) || 'text';
    const cast = CASTS[kind] || CASTS.text;
    return cast.parse(raw, spec || {});
}

/**
 * The canonical EDITING/interchange text for a cell's MODEL value — what F2-preserve seeds the
 * editor with, what an editable-grid copy writes to the TSV, and what a paste of that TSV
 * parses back to the same model value (the round-trip contract): date ISO → the operator's
 * display pattern, bool → "1"/"0", a registered kind's own editText (e.g. paise 12500 →
 * "125.00"), everything else → String(value).
 *
 * @param {{parse?: object}} column the serialized column config
 * @param {*} value the cell's model value
 * @returns {string}
 */
export function editTextFor(column, value) {
    const spec = (column && column.parse) || {};
    if (value == null || value === '') {
        return '';
    }

    const cast = CASTS[spec.kind];
    if (cast && cast.editText) {
        return cast.editText(value, spec);
    }

    return String(value);
}
