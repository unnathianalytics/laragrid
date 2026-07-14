/**
 * LaraGrid — client-side instant validator.
 *
 * What: Interpret a column's compiled client rule subset ({rule, value}[] from RuleCompiler) over
 *       one cell value and return the first violation message, or null when the value passes what
 *       the client can check.
 * Why:  Validation is dual (plan §2.5/G7): this gives the operator immediate "blank / too long /
 *       out of range" feedback with no round-trip, while the server has the final say (closures,
 *       cross-field, per-row required). The client set is a STRICT subset the RuleCompiler
 *       guarantees is safe to evaluate against a single cell — anything else is `serverOnly` and
 *       surfaces only when the server verdict lands. Messages are intentionally short and generic;
 *       the authoritative wording comes from the server.
 * When: Called by an editor's commit pipeline (before enqueuing the op) and by the ErrorPainter to
 *       decide the instant cell-error state.
 */
export default class ClientValidator {
    /**
     * Validate a value against a column's compiled `validate.client` rules.
     *
     * @param {Array<{rule: string, value?: *}>} rules
     * @param {*} value the parsed model value (paise int, decimal string, text, …)
     * @param {string} [label] the column label for messages
     * @returns {string|null} the first violation message, or null if it passes
     */
    validate(rules, value, label = 'This field') {
        if (!Array.isArray(rules)) {
            return null;
        }
        for (const spec of rules) {
            const message = this.check(spec, value, label);
            if (message) {
                return message;
            }
        }
        return null;
    }

    /** @returns {string|null} */
    check(spec, value, label) {
        switch (spec.rule) {
            case 'required':
                return this.isBlank(value) ? `${label} is required.` : null;
            case 'maxLength':
                return String(value ?? '').length > spec.value
                    ? `${label} must be at most ${spec.value} characters.`
                    : null;
            case 'min':
                return !this.isBlank(value) && this.toNumber(value) < spec.value
                    ? `${label} must be at least ${spec.value}.`
                    : null;
            case 'max':
                return !this.isBlank(value) && this.toNumber(value) > spec.value
                    ? `${label} must be at most ${spec.value}.`
                    : null;
            case 'regex':
                return !this.isBlank(value) && !this.matches(spec.value, value)
                    ? `${label} is invalid.`
                    : null;
            case 'numeric':
            case 'integer':
                return !this.isBlank(value) && Number.isNaN(this.toNumber(value))
                    ? `${label} must be a number.`
                    : null;
            default:
                return null; // unknown/server-only rule — client doesn't judge it
        }
    }

    isBlank(value) {
        return value === null || value === undefined || value === '';
    }

    toNumber(value) {
        return Number(String(value).replace(/[,\s]/g, ''));
    }

    /** Evaluate a Laravel-style regex rule payload ("/pattern/flags" or a bare pattern). */
    matches(pattern, value) {
        try {
            const m = String(pattern).match(/^\/(.*)\/([a-z]*)$/i);
            const re = m ? new RegExp(m[1], m[2]) : new RegExp(pattern);
            return re.test(String(value));
        } catch {
            // A pattern the browser can't compile is treated as server-only (don't false-fail).
            return true;
        }
    }
}
