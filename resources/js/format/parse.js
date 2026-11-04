/**
 * LaraGrid — client cast registry (the JS half of the cast pair with the PHP CastRegistry).
 *
 * What: Turn an operator's typed text into the column's model value per its `parse` spec kind —
 *       core kinds text / int / decimal(scale) / select / bool / date, plus registerCast(): the
 *       seam a consuming app uses to add its own kinds (each MUST mirror a PHP Cast it
 *       registered under the same kind). Also owns editTextFor(): the canonical
 *       EDITING/interchange text for a model value (what a content-preserving edit and copy
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
import { parseArithmetic } from '../formula/ExprParse.js';
import { evaluate } from '../formula/ExprEval.js';

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

/**
 * Evaluate calculator entry in a number cell (`1250*12`, `(2+3)*4`, `=100*1.18`). Mirrors
 * LaraGrid\Casting\Arithmetic::evaluate() rule for rule, pinned by arithmetic.json:
 *   - grouping (commas, whitespace) is stripped first, then one leading `=`;
 *   - without `=`, the text is an expression only when it holds nothing but digits, `.`,
 *     `+ - * / ( )` AND contains `+ * / ( )` or a `-` after a digit, `.` or `)` — so `-5` and
 *     `12,345` stay plain numbers, and plain non-numeric text stays on the silent-0 path;
 *   - a leading `=` always means an expression.
 * Division by zero is 0 (the formula engine's rule); a non-finite result is 0.
 *
 * @param {*} raw the operator's typed text
 * @returns {number|null|undefined} the value; `null` = not an expression (take the plain
 *          number path); `undefined` = a malformed expression (refuse the commit)
 */
export function evaluateArithmetic(raw) {
    const text = stripGrouping(raw);
    const explicit = text.charAt(0) === '=';
    const body = explicit ? text.slice(1) : text;

    if (!/^[0-9.+\-*/()]+$/.test(body)) {
        return explicit ? undefined : null;
    }
    if (!explicit && !/[+*/()]|[0-9.)]-/.test(body)) {
        return null;
    }

    let value;
    try {
        value = evaluate(parseArithmetic(body), {});
    } catch (e) {
        return undefined;
    }
    return Number.isFinite(value) ? value : 0;
}

/**
 * Parse to a whole number (grouping stripped, rounded half-up to an integer — half away from
 * zero, like PHP round()). Calculator entry evaluates first. Blank/invalid → 0; a malformed
 * expression → the `undefined` refusal sentinel.
 */
export function parseInt10(raw) {
    const arithmetic = evaluateArithmetic(raw);
    if (arithmetic === undefined) {
        return undefined;
    }
    if (arithmetic !== null) {
        return roundHalfUp(arithmetic, 0) + 0; // + 0 turns -0 into 0
    }
    const normalised = stripGrouping(raw);
    if (normalised === '' || Number.isNaN(Number(normalised))) {
        return 0;
    }
    return roundHalfUp(Number(normalised), 0) + 0;
}

/**
 * Parse to a fixed-scale decimal STRING (rounded half-up at scale), so precision never rides a
 * float (plan G2). Calculator entry evaluates first; a malformed expression → `undefined`.
 * Mirrors LaraGrid\Casting\Casts\DecimalCast.
 */
export function parseDecimal(raw, scale) {
    const arithmetic = evaluateArithmetic(raw);
    if (arithmetic === undefined) {
        return undefined;
    }
    let number = arithmetic;
    if (number === null) {
        const normalised = stripGrouping(raw);
        number = normalised === '' || Number.isNaN(Number(normalised)) ? 0 : Number(normalised);
    }
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
 * The cast registry: kind → {parse(raw, spec), editText?(value, spec), refusal?, arithmetic?}.
 * Core kinds mirror LaraGrid\Casting\CastRegistry; registerCast() adds app kinds (e.g. an
 * accounting app's 'paise'). `editText` is optional — kinds whose model value isn't its own
 * editing text (dates, booleans, scaled money) supply one; others fall back to String(value).
 * `refusal` is the cell message shown when parse returns the `undefined` sentinel (see
 * refusalMessage()). `arithmetic: true` says the parse evaluates calculator entry (through
 * evaluateArithmetic()), so the number editor lets the operator type `+ - * / ( ) =`.
 */
const CASTS = {
    text: {
        parse: (raw, spec) => parseText(raw, spec ? spec.case : null),
    },
    int: {
        parse: (raw) => parseInt10(raw),
        refusal: 'Not a valid number or expression.',
        arithmetic: true,
    },
    decimal: {
        parse: (raw, spec) => parseDecimal(raw, Math.max(0, parseInt(spec && spec.scale, 10) || 0)),
        refusal: 'Not a valid number or expression.',
        arithmetic: true,
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
        refusal: 'Not a recognisable date.',
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
 * @param {{parse: (raw: *, spec: object) => *, editText?: (value: *, spec: object) => string, refusal?: string, arithmetic?: boolean}} cast
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
 * @returns {*} `undefined` ONLY for a refusal (an unparseable date, a malformed expression)
 */
export function parseValue(spec, raw) {
    const kind = (spec && spec.kind) || 'text';
    const cast = CASTS[kind] || CASTS.text;
    return cast.parse(raw, spec || {});
}

/**
 * Whether a column's parse kind evaluates calculator entry: the core int/decimal kinds, or an
 * app kind registered with `arithmetic: true`. The number editor accepts `+ - * / ( ) =` only
 * then — any other kind (an app's 'paise' that never evaluates) keeps the plain number keys,
 * so `1250*12` can never be typed into a cell that would silently store 0.
 *
 * @param {{kind?: string}|null|undefined} spec
 * @returns {boolean}
 */
export function acceptsArithmetic(spec) {
    const cast = CASTS[(spec && spec.kind) || 'text'];
    return !!(cast && cast.arithmetic);
}

/**
 * The cell message for a parse refusal (parseValue returned `undefined`) under a column's parse
 * spec: the kind's own `refusal` text, else a neutral fallback.
 *
 * @param {{kind?: string}|null|undefined} spec
 * @returns {string}
 */
export function refusalMessage(spec) {
    const cast = CASTS[(spec && spec.kind) || 'text'];
    return (cast && cast.refusal) || 'Not a valid value.';
}

/**
 * The canonical EDITING/interchange text for a cell's MODEL value — what a preserving edit seeds
 * the editor with, what an editable-grid copy writes to the TSV, and what a paste of that TSV
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
