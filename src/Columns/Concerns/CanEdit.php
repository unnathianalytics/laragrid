<?php

declare(strict_types=1);

namespace LaraGrid\Columns\Concerns;

use Closure;

/**
 * What: The editable-column fluent surface — validation rules, required/readonly (static or
 *       per-row), text length + case transforms — plus the accessors the OpApplier and the
 *       ConfigSerializer read to build the client's editor + validation config.
 *
 * Why:  M4 turns display columns into editable ones; concentrating the editable knobs in one
 *       concern keeps the concrete column types tiny (they only declare their editor id + parse
 *       contract) and keeps the base Column free of edit specifics for the display-only types.
 *       Everything here is a DECLARATION — the parse/validate/format LOGIC lives in the client
 *       (instant) and the server OpApplier/RuleCompiler (authoritative), never in prose here
 *       (plan §2.1 "declarative bridge"). Per-row readonly/required are closures resolved on the
 *       server against the row; the client is handed the resulting flags/rules, not the closure.
 *
 * When: Mixed into the Column base so any column CAN be editable; only types that declare an
 *       editorId() (Text/Integer/Decimal/Qty/Amount) actually open an editor.
 */
trait CanEdit
{
    /**
     * Declared validation rules for this column — Laravel rule strings/objects the RuleCompiler
     * turns into a server validator + a client-side declarative subset.
     *
     * @var list<mixed>
     */
    protected array $rules = [];

    /** Static required flag, or a per-row closure fn(array $row): bool resolved server-side. */
    protected bool|Closure $required = false;

    /** Static readonly flag, or a per-row closure fn(array $row): bool resolved server-side. */
    protected bool|Closure $readonly = false;

    /** Max input length for text editors (null = unbounded). */
    protected ?int $maxLength = null;

    /** Optional input case transform: 'upper' | 'lower' | null. */
    protected ?string $caseTransform = null;

    /**
     * Declarative sibling writes applied when this column commits a NON-BLANK value:
     * fixed values to set and columns to clear on the same row.
     *
     * @var array<string, scalar>
     */
    protected array $whenFilledSets = [];

    /** @var list<string> */
    protected array $whenFilledClears = [];

    /**
     * Declarative per-cell lock: {column, in} — this column's cells are locked when the same
     * row's `column` value is one of `in`. Null when never declared.
     *
     * @var array{column: string, in: list<string>}|null
     */
    protected ?array $lockedWhen = null;

    /**
     * Declarative per-cell ENTRY requirement: {column, in} — this column's cells block the
     * NAV-Enter advance while blank when the same row's `column` value is one of `in`.
     * Null when never declared.
     *
     * @var array{column: string, in: list<string>}|null
     */
    protected ?array $requiredWhen = null;

    /**
     * Declare validation rules (Laravel rule syntax). Merged with the type/required rules.
     *
     * @param  array<int, mixed>  $rules  Re-indexed to a list.
     */
    public function rules(array $rules): static
    {
        $this->rules = array_values($rules);

        return $this;
    }

    /**
     * Mark the column required — statically, or per-row via a closure fn(array $row): bool.
     *
     * @param  bool|Closure(array<string, mixed>): bool  $required
     */
    public function required(bool|Closure $required = true): static
    {
        $this->required = $required;

        return $this;
    }

    /**
     * Mark the column readonly — statically, or per-row via a closure fn(array $row): bool. A
     * readonly cell is skipped by edit landing and rejected by the OpApplier.
     *
     * @param  bool|Closure(array<string, mixed>): bool  $readonly
     */
    public function readonly(bool|Closure $readonly = true): static
    {
        $this->readonly = $readonly;

        return $this;
    }

    public function maxLength(int $length): static
    {
        $this->maxLength = max(0, $length);

        return $this;
    }

    /**
     * Declare sibling-cell writes for a non-blank commit to this column: `$sets` are fixed
     * values written to named columns, `$clears` are columns blanked — on the same row.
     *
     * Why: A mutually-exclusive column pair (the voucher's Debit/Credit under a D/C selector)
     *      needs its dependents updated the INSTANT the operator commits, not a round-trip later.
     *      This is a pure DECLARATION (no logic smuggling, R2): the client mirrors it optimistically
     *      in the one commit pipeline, while the server's afterCellChange hook remains the
     *      authoritative implementation whose write-backs reconcile the same cells.
     *
     * @param  array<string, scalar>  $sets  column => fixed value
     * @param  array<int, string>  $clears  columns to blank (re-indexed to a list)
     */
    public function whenFilled(array $sets = [], array $clears = []): static
    {
        $this->whenFilledSets = $sets;
        $this->whenFilledClears = array_values($clears);

        return $this;
    }

    /**
     * Declare a per-cell lock keyed on a SIBLING column's value: this column's cells are locked
     * (editor refused, serpentine navigation skips them, painted muted) on every row whose
     * `$column` value is one of `$values`.
     *
     * Why: The client CAN pre-evaluate this — unlike a per-row readonly closure, which is a
     *      server-only verdict (the M6 optimistic-paint-then-error trap). Like whenFilled, it is
     *      a pure DECLARATION (no logic smuggling): the client mirrors it instantly for
     *      navigation/edit landing, while any authoritative reconciliation (e.g. the voucher's
     *      typed-side-wins afterCellChange hook) stays server-side and unchanged.
     * When: Declared on mutually-exclusive column pairs gated by a selector column — the voucher
     *       grid's Debit/Credit under its D/C side selector.
     *
     * @param  string  $column  The controlling sibling column key (e.g. 'dc').
     * @param  string|array<int, string>  $values  Value(s) of `$column` that lock this cell.
     */
    public function lockedWhen(string $column, string|array $values): static
    {
        $this->lockedWhen = [
            'column' => $column,
            'in' => array_values(array_map(fn ($value): string => (string) $value, (array) $values)),
        ];

        return $this;
    }

    /**
     * The declared per-cell lock, or null.
     *
     * @return array{column: string, in: list<string>}|null
     */
    public function getLockedWhen(): ?array
    {
        return $this->lockedWhen;
    }

    /**
     * The `lockedWhen` config fragment — emitted only when declared (the whenFilled golden-config
     * discipline: grids without it keep their exact config shape).
     *
     * @return array<string, array{column: string, in: list<string>}>
     */
    protected function serializeLockedWhen(): array
    {
        if ($this->lockedWhen === null) {
            return [];
        }

        return ['lockedWhen' => $this->lockedWhen];
    }

    /**
     * Declare a per-cell ENTRY requirement keyed on a SIBLING column's value: while the row's
     * `$column` value is one of `$values`, Enter must not advance past this cell blank (the G7
     * blank-required block, flash included) — the client evaluates it per row, exactly like
     * lockedWhen.
     *
     * Why: A mutually-exclusive pair can't be statically required (its locked side is always
     *      blank — a static rule would deadlock the row), and a per-row required closure is a
     *      server-only verdict the client can't consult mid-keystroke. This is NAVIGATION-only
     *      by design: clearing the cell via an op stays legal (rebalancing edits an amount to
     *      empty first), and the save path's own validation remains the data authority.
     * When: The active-side amount under a selector — the voucher's Debit on 'D' rows, Credit
     *       on 'C' rows: an engaged row must carry its amount before Enter flows on.
     *
     * @param  string  $column  The controlling sibling column key (e.g. 'dc').
     * @param  string|array<int, string>  $values  Value(s) of `$column` that require this cell.
     */
    public function requiredWhen(string $column, string|array $values): static
    {
        $this->requiredWhen = [
            'column' => $column,
            'in' => array_values(array_map(fn ($value): string => (string) $value, (array) $values)),
        ];

        return $this;
    }

    /**
     * The declared per-cell entry requirement, or null.
     *
     * @return array{column: string, in: list<string>}|null
     */
    public function getRequiredWhen(): ?array
    {
        return $this->requiredWhen;
    }

    /**
     * The `requiredWhen` config fragment — emitted only when declared (golden-config discipline).
     *
     * @return array<string, array{column: string, in: list<string>}>
     */
    protected function serializeRequiredWhen(): array
    {
        if ($this->requiredWhen === null) {
            return [];
        }

        return ['requiredWhen' => $this->requiredWhen];
    }

    /**
     * @return array<string, scalar>
     */
    public function getWhenFilledSets(): array
    {
        return $this->whenFilledSets;
    }

    /**
     * @return list<string>
     */
    public function getWhenFilledClears(): array
    {
        return $this->whenFilledClears;
    }

    /**
     * The `whenFilled` config fragment — emitted only when declared, so grids without it keep
     * their exact config shape (golden fixtures don't rot; additive keys only).
     *
     * @return array<string, array{sets: array<string, scalar>, clears: list<string>}>
     */
    protected function serializeWhenFilled(): array
    {
        if ($this->whenFilledSets === [] && $this->whenFilledClears === []) {
            return [];
        }

        return ['whenFilled' => ['sets' => $this->whenFilledSets, 'clears' => $this->whenFilledClears]];
    }

    public function upper(): static
    {
        $this->caseTransform = 'upper';

        return $this;
    }

    public function lower(): static
    {
        $this->caseTransform = 'lower';

        return $this;
    }

    /**
     * The declared rules (without the implicit `required` / type rule the RuleCompiler adds).
     *
     * @return list<mixed>
     */
    public function getRules(): array
    {
        return $this->rules;
    }

    /**
     * Resolve whether the column is required for a given row (evaluates the per-row closure).
     *
     * @param  array<string, mixed>  $row
     */
    public function isRequiredFor(array $row): bool
    {
        return $this->required instanceof Closure ? (bool) ($this->required)($row) : $this->required;
    }

    /**
     * Resolve whether the column is readonly for a given row (evaluates the per-row closure).
     *
     * @param  array<string, mixed>  $row
     */
    public function isReadonlyFor(array $row): bool
    {
        return $this->readonly instanceof Closure ? (bool) ($this->readonly)($row) : $this->readonly;
    }

    /** Whether required is a per-row closure (so the client can't precompute a static flag). */
    public function isRequiredDynamic(): bool
    {
        return $this->required instanceof Closure;
    }

    /** Whether required is a static `true` (safe to project into the client rule set). */
    public function isRequiredStatic(): bool
    {
        return $this->required === true;
    }

    protected function readonlyIsDynamic(): bool
    {
        return $this->readonly instanceof Closure;
    }

    public function getMaxLength(): ?int
    {
        return $this->maxLength;
    }

    public function getCaseTransform(): ?string
    {
        return $this->caseTransform;
    }
}
