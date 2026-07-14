/**
 * What: The app's shared pure date helpers — the Busy-style freeform parser (any separator,
 *       compact digits, 2-digit years, financial-year inference for a missing year) and the
 *       canonical formatters, extracted verbatim from resources/js/form-kit/date.js.
 * Why:  Two keyboard-first surfaces accept fuzzy typed dates — the form-kit <x-uf.date> field
 *       and the datagrid's DateEditor (M5) — and they MUST resolve identically. One shared pure
 *       module is the anti-drift lock (umbrella plan §2.4: "the form-kit date parser reused as a
 *       shared module"); the datagrid commits the RESOLVED canonical ISO value, so no second
 *       (PHP) fuzzy parser exists anywhere. Kept pure (no Alpine/DOM) so Node tests pin it.
 * When: Imported by resources/js/form-kit/date.js (which re-exports, keeping its public API),
 *       by resources/js/datagrid/format/parse.js (kind 'date'), and by the Node test suites
 *       (form-kit/date.test.mjs via the re-export; tests/js picker vectors directly).
 *
 * @typedef {{ d: number, m: number, y: number }} DateParts
 */

/** Days in a given 1-indexed month of a given year (handles leap Februaries). */
function daysInMonth(month, year) {
    return new Date(year, month, 0).getDate();
}

/** Zero-pad a number to two digits. */
function pad2(value) {
    return String(value).padStart(2, '0');
}

/**
 * What: Parse arbitrary user date text into {d, m, y}, or null when unparseable.
 * Why:  The single source of truth for every accepted format. Kept PURE (no Alpine/DOM) so
 *       it is exhaustively unit-tested in date.test.mjs. Year inference uses the financial
 *       year: with no year typed, the day/month is placed in whichever calendar year keeps
 *       it inside the current FY window (month >= fyStartMonth → fyStartYear, else + 1).
 * When: From the form-kit resolve() on blur/Enter, the datagrid DateEditor commit + TSV paste,
 *       and directly from the unit tests.
 *
 * @param {string} raw            The user's typed text.
 * @param {number} fyStartMonth   1-indexed month the financial year starts (e.g. 4 = April).
 * @param {number} fyStartYear    Calendar year the current financial year starts in.
 * @returns {DateParts|null}
 */
export function parseFreeform(raw, fyStartMonth, fyStartYear) {
    const text = String(raw ?? '').trim();
    if (text === '') {
        return null;
    }

    let day;
    let month;
    let year = null;

    if (/\D/.test(text)) {
        // Contains separators: split on runs of any non-digit, drop empties.
        const parts = text.split(/\D+/).filter((token) => token !== '');
        if (parts.length < 2 || parts.length > 3) {
            return null;
        }
        if (parts.some((token) => !/^\d+$/.test(token))) {
            return null;
        }

        day = Number(parts[0]);
        month = Number(parts[1]);
        if (parts.length === 3) {
            year = normalizeYear(parts[2]);
            if (year === null) {
                return null;
            }
        }
    } else {
        // Pure digits: infer field widths from length.
        if (text.length === 8) {
            // ddmmyyyy
            day = Number(text.slice(0, 2));
            month = Number(text.slice(2, 4));
            year = Number(text.slice(4, 8));
        } else if (text.length === 6) {
            // ddmmyy
            day = Number(text.slice(0, 2));
            month = Number(text.slice(2, 4));
            year = normalizeYear(text.slice(4, 6));
        } else if (text.length === 4) {
            // ddmm (year inferred)
            day = Number(text.slice(0, 2));
            month = Number(text.slice(2, 4));
        } else {
            // Too short/long to be an unambiguous compact date.
            return null;
        }
    }

    // Infer the year from the financial year window when none was supplied.
    if (year === null) {
        if (!Number.isInteger(month) || month < 1 || month > 12) {
            return null;
        }
        year = month >= fyStartMonth ? fyStartYear : fyStartYear + 1;
    }

    return validate(day, month, year);
}

/**
 * What: Expand a raw year token to a 4-digit year, or null if unusable.
 * Why:  2-digit years always map to 2000+ (accounting works with near-term dates; a pivot
 *       window would surprise more than it helps). 4-digit passes through; other lengths
 *       (1, 3, 5+) are rejected as too ambiguous.
 * When: From parseFreeform for both the separated and compact `yy` cases.
 *
 * @param {string} token
 * @returns {number|null}
 */
function normalizeYear(token) {
    if (token.length === 2) {
        return 2000 + Number(token);
    }
    if (token.length === 4) {
        return Number(token);
    }
    return null;
}

/**
 * Validate day/month/year ranges (month 1–12, day within that month) → DateParts or null.
 */
function validate(day, month, year) {
    if (!Number.isInteger(day) || !Number.isInteger(month) || !Number.isInteger(year)) {
        return null;
    }
    if (month < 1 || month > 12) {
        return null;
    }
    if (day < 1 || day > daysInMonth(month, year)) {
        return null;
    }
    return { d: day, m: month, y: year };
}

/**
 * What: Render DateParts to the value that flows into Livewire (the bound property).
 * Why:  The emitted format is a per-call-site concern: ISO `Y-m-d` for properties parsed by
 *       Carbon/cast to a DB date, human `d-m-Y` otherwise. Only these two are produced.
 * When: From the form-kit syncToLivewire() commit, the datagrid date parse, and tests.
 *
 * @param {DateParts} parts
 * @param {'d-m-Y'|'Y-m-d'} valueFormat
 * @returns {string}
 */
export function formatValue(parts, valueFormat) {
    const dd = pad2(parts.d);
    const mm = pad2(parts.m);
    const yyyy = String(parts.y).padStart(4, '0');

    if (valueFormat === 'Y-m-d') {
        return `${yyyy}-${mm}-${dd}`;
    }
    return `${dd}-${mm}-${yyyy}`;
}

/**
 * What: The canonical human display text (dd-mm-yyyy) shown in the box after a resolve.
 * Why:  Regardless of how the user typed it, the field snaps to one unambiguous display so
 *       they can confirm what was understood.
 * When: From the form-kit resolve(), the datagrid edit-text derivation, and tests.
 *
 * @param {DateParts} parts
 * @returns {string}
 */
export function formatDisplay(parts) {
    return `${pad2(parts.d)}-${pad2(parts.m)}-${String(parts.y).padStart(4, '0')}`;
}

/**
 * What: Split an ISO `Y-m-d` (or an already-`d-m-Y`) string into DateParts, or null.
 * Why:  Bridges the native picker (always ISO) and any pre-filled bound value back into the
 *       same DateParts the formatters consume, without re-running the fuzzy parser.
 * When: From the form-kit init()/fromNative(), the datagrid date parse (ISO passthrough),
 *       and tests.
 *
 * @param {string} value
 * @returns {DateParts|null}
 */
export function partsFromValue(value) {
    const text = String(value ?? '').trim();
    if (text === '') {
        return null;
    }

    let isoMatch = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (isoMatch) {
        return validate(Number(isoMatch[3]), Number(isoMatch[2]), Number(isoMatch[1]));
    }

    let dmyMatch = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dmyMatch) {
        return validate(Number(dmyMatch[1]), Number(dmyMatch[2]), Number(dmyMatch[3]));
    }

    return null;
}

/**
 * What: Render DateParts to the native `<input type="date">` value, which is always ISO.
 * When: From the form-kit init()/resolve() native sync and the datagrid date parse.
 *
 * @param {DateParts} parts
 * @returns {string}
 */
export function formatIso(parts) {
    return formatValue(parts, 'Y-m-d');
}
