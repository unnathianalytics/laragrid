<?php

declare(strict_types=1);

namespace LaraGrid\Validation;

use LaraGrid\Columns\Column;

/**
 * What: Compiles a column's declared validation into (a) a Laravel ruleset the OpApplier runs
 *       server-side (authoritative, including closures and cross-field rules) and (b) a small
 *       DECLARATIVE JSON subset the client ClientValidator interprets for instant feedback.
 *
 * Why:  Validation is deliberately dual (plan §2.5/G7): the client gives an operator immediate
 *       "this is blank/too long" feedback with no round-trip, while the server has the final say
 *       (it alone can run a closure or check a sibling cell). Concentrating BOTH derivations here
 *       means the two never drift by hand — the client subset is a strict projection of the server
 *       rules, and anything the client can't evaluate safely (a closure, a cross-row rule) is
 *       simply omitted from the client set and surfaces only as the server's verdict. No rule
 *       LOGIC lives here; this only translates declarations into the two rule shapes.
 *
 * When: Called by ConfigSerializer to attach each editable column's `validate` block to config,
 *       and by the OpApplier to build the server validator for an incoming write.
 */
class RuleCompiler
{
    /**
     * The Laravel ruleset for a column, given the row being validated (so a per-row required
     * closure resolves). Used server-side by the OpApplier.
     *
     * What: Prepends `required`/`nullable` from the resolved required flag, then the caller's
     *       declared rules verbatim (strings, Rule objects, closures — all valid Laravel rules).
     * Why:  The server validator is authoritative and can run everything Laravel supports; we do
     *       not narrow it. The row lets a per-row `required(fn ($row) => …)` decide.
     *
     * @param  array<string, mixed>  $row
     * @return list<mixed>
     */
    public function serverRules(Column $column, array $row): array
    {
        $rules = [];
        $rules[] = $column->isRequiredFor($row) ? 'required' : 'nullable';

        foreach ($column->getRules() as $rule) {
            $rules[] = $rule;
        }

        // maxLength is an editor constraint and a server invariant. Keeping it out of this
        // ruleset allowed a forged gridRows()/gridOps payload to bypass the client limit.
        if (($maxLength = $column->getMaxLength()) !== null) {
            $rules[] = 'max:'.$maxLength;
        }

        // Type-implicit guards (embedded in: whitelist, boolean, strict date_format) — the
        // server-side floor a client can't opt out of, appended after the author's rules.
        foreach ($column->implicitRules() as $rule) {
            $rules[] = $rule;
        }

        return $rules;
    }

    /**
     * The declarative client-side rule subset for a column, serialized into config.
     *
     * What: Each entry is `{rule, value?}`. Emits `required` when required *statically* (a per-row
     *       required closure can't be evaluated client-side, so it is omitted — the server verdict
     *       covers it), plus the string rules the client can honestly evaluate against a single
     *       cell value: min/max (numeric), size/between bounds, regex, and maxLength (from the
     *       column). Rules the client cannot safely evaluate (closures, prohibited_with / required_with
     *       and other cross-field rules, `unique`, `exists`, …) are intentionally NOT projected —
     *       they remain server-only.
     *
     * @return list<array{rule: string, value?: mixed}>
     */
    public function clientRules(Column $column): array
    {
        return $this->compile($column)['client'];
    }

    /**
     * Project a single Laravel string rule into zero or more client rule entries. Only the rules
     * the client can evaluate against one cell value are projected; everything else yields [].
     *
     * @return list<array{rule: string, value?: mixed}>
     */
    protected function projectStringRule(string $rule): array
    {
        // A rule may carry parameters after a colon, e.g. "min:0", "between:1,100", "regex:/…/".
        [$name, $paramString] = array_pad(explode(':', $rule, 2), 2, null);
        $params = $paramString === null ? [] : explode(',', $paramString);

        return match ($name) {
            'required' => [['rule' => 'required']],
            'min' => isset($params[0]) ? [['rule' => 'min', 'value' => (float) $params[0]]] : [],
            'max' => isset($params[0]) ? [['rule' => 'max', 'value' => (float) $params[0]]] : [],
            'between' => isset($params[0], $params[1])
                ? [['rule' => 'min', 'value' => (float) $params[0]], ['rule' => 'max', 'value' => (float) $params[1]]]
                : [],
            'regex' => $paramString !== null ? [['rule' => 'regex', 'value' => $paramString]] : [],
            'numeric', 'integer' => [['rule' => $name]],
            default => [], // cross-field / db / unknown rules stay server-only
        };
    }

    /**
     * The full editable `validate` block for a column's config: the client subset (declarative)
     * plus a flag telling the client whether the server may add rules it can't see (a closure /
     * cross-field / per-row required) so the UI knows a server verdict can still arrive.
     *
     * @return array{client: list<array{rule: string, value?: mixed}>, serverOnly: bool}
     */
    public function toConfig(Column $column): array
    {
        return $this->compile($column);
    }

    /**
     * Whether the column has any rule the client can't evaluate (a closure, a per-row required
     * closure, or a cross-field/db string rule) — so the client expects a possible server verdict.
     */
    protected function hasServerOnlyRules(Column $column): bool
    {
        return $this->compile($column)['serverOnly'];
    }

    /**
     * The client subset and the serverOnly flag, from one walk over the declared rules.
     *
     * What: Each string rule is projected once: a non-empty projection joins the client set,
     *       an empty one (cross-field, db, unknown) marks the column serverOnly. Any non-string
     *       rule (a closure, a Rule object, an array) is serverOnly too, as are a per-row
     *       required closure and the implicit type rules (in:, boolean, date_format).
     * Why:  toConfig() runs per editable column on every full render; projecting each rule
     *       once for the client list and again for the flag doubled that work.
     *
     * @return array{client: list<array{rule: string, value?: mixed}>, serverOnly: bool}
     */
    private function compile(Column $column): array
    {
        $client = [];

        // Static required only — a Closure required is server-resolved (no client projection).
        if ($column->isRequiredStatic()) {
            $client[] = ['rule' => 'required'];
        }

        if (($max = $column->getMaxLength()) !== null) {
            $client[] = ['rule' => 'maxLength', 'value' => $max];
        }

        $serverOnly = $column->isRequiredDynamic() || $column->implicitRules() !== [];

        foreach ($column->getRules() as $rule) {
            if (! is_string($rule)) {
                $serverOnly = true; // closures, Rule objects, arrays

                continue;
            }

            $projected = $this->projectStringRule($rule);
            if ($projected === []) {
                $serverOnly = true;

                continue;
            }

            foreach ($projected as $entry) {
                $client[] = $entry;
            }
        }

        return ['client' => $client, 'serverOnly' => $serverOnly];
    }
}
