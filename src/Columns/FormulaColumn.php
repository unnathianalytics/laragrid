<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

use LaraGrid\Expression\Ast\Node;
use LaraGrid\Expression\Parser;

/**
 * What: A display-only column whose value is COMPUTED from an arithmetic expression over other
 *       columns (e.g. 'round(qty * rate - discount, 2)'), evaluated in BOTH runtimes from one
 *       AST — the client for instant feel, the server authoritatively.
 *
 * Why:  Line grids live on derived values (amount = qty × rate, tax = amount × rate%). Doing this
 *       as a shared AST — parsed ONCE in PHP, shipped as data, walked by two dumb evaluators — is
 *       the plan's answer to two-runtime drift (R2): there is one grammar and one parser, never
 *       duplicated logic, and the equality is pinned by shared vectors. Distinct from
 *       ComputedColumn (server-only closure) precisely because a formula must recompute on the
 *       client the instant a dependency changes, with no round-trip.
 *
 * When: Any editable line grid with a derived cell. The column is not itself editable
 *       (editorId() stays null); its value is written back by the OpApplier + recomputed client-side.
 */
final class FormulaColumn extends Column
{
    protected string $expression = '';

    /** The parsed AST, built lazily on first access and cached. */
    protected ?Node $ast = null;

    /**
     * Set the arithmetic expression. Grammar: numbers, column refs, + - * / %, parens,
     * comparisons, and round/min/max/abs/ceil/floor/if. Parsed to an AST at serialize time.
     */
    public function formula(string $expression): static
    {
        $this->expression = $expression;
        $this->ast = null;

        return $this;
    }

    public function getExpression(): string
    {
        return $this->expression;
    }

    /**
     * The parsed AST for this formula (cached). The Parser is the ONLY parser in the system; the
     * client never parses — it walks the serialized tree.
     */
    public function ast(): Node
    {
        return $this->ast ??= (new Parser)->parse($this->expression);
    }

    protected function configureDefaults(): void
    {
        $this->defaultAlign('right');
    }

    public function painterId(): string
    {
        return 'formula';
    }

    /** Formula cells are numeric — summable in the status bar and the footer. */
    public function isSelectableNumeric(): bool
    {
        return true;
    }

    /**
     * The formula's serialized AST + source. The client evaluates the AST (ExprEval); the server
     * evaluates the same AST authoritatively (Evaluator) on every op that touches a dependency.
     *
     * @return array{formula: array{expr: string, ast: array<string, mixed>}}
     */
    protected function serializeType(): array
    {
        return [
            'formula' => [
                'expr' => $this->expression,
                'ast' => $this->ast()->toArray(),
            ],
        ];
    }
}
