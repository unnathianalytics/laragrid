<?php

declare(strict_types=1);

namespace LaraGrid\Editing;

use Illuminate\Support\Facades\Validator;
use LaraGrid\Casting\CastRegistry;
use LaraGrid\Columns\Column;
use LaraGrid\Columns\FormulaColumn;
use LaraGrid\Columns\SearchSelectColumn;
use LaraGrid\Expression\Evaluator;
use LaraGrid\Grid;
use LaraGrid\Validation\RuleCompiler;

/**
 * What: The server-authoritative core of the op protocol — applies a client OpBatch to a grid's
 *       rows and produces the OpResult (write-backs, per-cell errors, recomputed footer, new
 *       version, applied rows, and the refreshHost decision).
 *
 * Why:  "Optimistic client, authoritative server" (plan §2.1): the client painted the edit
 *       instantly, but THIS is where the ledger's truth is decided. For every op it maps the
 *       stable `_k` to an index (never trusting a position, G1), rejects writes to columns the
 *       client must not set (Readonly/Formula/Computed, and Hidden unless ->writable() — G12),
 *       casts the typed text to the column's model value exactly as the JS parser does (the pair
 *       pinned by intent, R2), validates via the RuleCompiler's server ruleset (closures and all),
 *       runs the grid's hooks (the generalised item-pick enrichment, §2.5.3), recomputes every
 *       FormulaColumn authoritatively, and applies row insert/remove/dup/fill with echoed keys.
 *       Blank trailing rows are excluded from validation and footer totals (G4). A stale `_k` or a
 *       rejected write becomes an op error, never a crash — a malformed edit must not break entry.
 *
 * When: Called by WithLaraGrid::gridOps() with the host's bound rows + the parsed batch.
 *
 * @phpstan-type OpResultShape array{seq: int, ok: bool, patch: array<string, array<string, mixed>>, errors: array<string, array<string, string>>}
 */
class OpApplier
{
    public function __construct(
        private readonly RuleCompiler $ruleCompiler = new RuleCompiler,
        private readonly Evaluator $evaluator = new Evaluator,
        private readonly CastRegistry $casts = new CastRegistry,
    ) {}

    /**
     * Apply a batch to a copy of the grid's rows.
     *
     * @param  list<array<string, mixed>>  $rows  The host's current rows (each carrying `_k`).
     * @param  int  $version  The grid's current server version.
     */
    public function apply(Grid $grid, array $rows, OpBatch $batch, int $version = 0): OpResult
    {
        /** @var list<OpResultShape> $results */
        $results = [];
        $refreshHost = false;
        $refreshCols = array_flip($grid->getRefreshesHost());

        foreach ($batch->ops as $op) {
            [$rows, $result, $touchedRefresh] = $this->applyOp($grid, $rows, $op, $refreshCols);
            $results[] = $result;
            $refreshHost = $refreshHost || $touchedRefresh;
            $version++;
        }

        return new OpResult(
            version: $version,
            results: $results,
            footer: $this->computeFooter($grid, $rows),
            rows: $rows,
            refreshHost: $refreshHost,
        );
    }

    /**
     * Apply a single op; returns [rows, result, touchedRefreshColumn].
     *
     * @param  list<array<string, mixed>>  $rows
     * @param  array<string, int>  $refreshCols
     * @return array{0: list<array<string, mixed>>, 1: OpResultShape, 2: bool}
     */
    private function applyOp(Grid $grid, array $rows, Op $op, array $refreshCols): array
    {
        return match ($op->kind) {
            Op::SET => $this->applySet($grid, $rows, $op, $refreshCols),
            Op::FILL => $this->applyFill($grid, $rows, $op, $refreshCols),
            Op::INSERT => $this->applyInsert($grid, $rows, $op),
            Op::REMOVE => $this->applyRemove($grid, $rows, $op),
            Op::DUP => $this->applyDup($grid, $rows, $op),
            default => [$rows, $this->fail($op, '_row', 'Unknown operation.'), false],
        };
    }

    /**
     * Apply a cell set: authorize the column, cast + validate the value, run the hook + formulas,
     * and collect the write-back patch.
     *
     * @param  list<array<string, mixed>>  $rows
     * @param  array<string, int>  $refreshCols
     * @return array{0: list<array<string, mixed>>, 1: OpResultShape, 2: bool}
     */
    private function applySet(Grid $grid, array $rows, Op $op, array $refreshCols): array
    {
        $index = $this->indexOfKey($rows, (string) $op->row);
        if ($index === null) {
            return [$rows, $this->fail($op, '_row', 'That row no longer exists.', $rows), false];
        }

        $column = $grid->column((string) $op->col);
        if ($column === null) {
            return [$rows, $this->fail($op, (string) $op->col, 'Unknown column.'), false];
        }

        // Write authorization (G12): reject a client write the column type doesn't allow.
        if (! $column->isWritable() || $column->isReadonlyFor($rows[$index])) {
            return [$rows, $this->fail($op, $column->key, 'This cell is not editable.'), false];
        }

        $cast = $this->castValue($column, $op->value);
        $rows[$index][$column->key] = $cast;

        // Validate the cast value against the column's server ruleset (skip blank trailing rows).
        $errors = [];
        if (! $this->isBlankTrailing($grid, $rows, $index)) {
            $errors = $this->validateCell($column, $rows[$index], $cast);
        }

        $patch = [];
        if ($errors === []) {
            // Picker bookkeeping + hooks + formula recompute produce authoritative write-backs
            // the client reconciles. Order: label the pick, run the COLUMN's onSelect enrichment
            // (umbrella §2.5.3), then the grid-level afterCellChange, then formulas over the
            // final row state.
            $rows[$index] = $this->applyPickLabel($column, $rows[$index], $op);
            $rows[$index] = $this->runSelectHook($column, $rows[$index], $cast, $patch);
            $rows[$index] = $this->runCellHook($grid, $rows[$index], $column->key, $patch);
            $rows[$index] = $this->recomputeFormulas($grid, $rows[$index], $patch);
        }

        $rowKey = (string) $op->row;
        $result = [
            'seq' => $op->seq,
            'ok' => $errors === [],
            'patch' => $patch === [] ? [] : [$rowKey => $patch],
            'errors' => $errors === [] ? [] : [$rowKey => [$column->key => $errors[0]]],
        ];

        $touchedRefresh = isset($refreshCols[$column->key])
            || array_intersect_key($patch, $refreshCols) !== [];

        return [$rows, $result, $touchedRefresh];
    }

    /**
     * Apply a fill-down (Ctrl+D): copy the source (first) row's column value across the listed rows.
     *
     * @param  list<array<string, mixed>>  $rows
     * @param  array<string, int>  $refreshCols
     * @return array{0: list<array<string, mixed>>, 1: OpResultShape, 2: bool}
     */
    private function applyFill(Grid $grid, array $rows, Op $op, array $refreshCols): array
    {
        $column = $grid->column((string) $op->col);
        if ($column === null || ! $column->isWritable()) {
            return [$rows, $this->fail($op, (string) $op->col, 'This column cannot be filled.'), false];
        }

        $keys = $op->rows ?? [];
        $sourceIndex = $this->indexOfKey($rows, $keys[0]);
        if ($sourceIndex === null) {
            return [$rows, $this->fail($op, '_row', 'The source row no longer exists.', $rows), false];
        }
        $sourceValue = $rows[$sourceIndex][$column->key] ?? null;

        // A picker column's fill also carries the source's display label — a copied id with the
        // old row's label left behind would mislabel the target (M5).
        $isPicker = ($column->parseSpec()['kind'] ?? null) === 'select';
        $sourceLabels = is_array($rows[$sourceIndex]['_labels'] ?? null) ? $rows[$sourceIndex]['_labels'] : [];
        $sourceLabel = $sourceLabels[$column->key] ?? null;

        $patch = [];
        foreach (array_slice($keys, 1) as $key) {
            $index = $this->indexOfKey($rows, $key);
            if ($index === null || $column->isReadonlyFor($rows[$index])) {
                continue;
            }
            $rows[$index][$column->key] = $sourceValue;
            $rowPatch = [];
            if ($isPicker) {
                $labels = is_array($rows[$index]['_labels'] ?? null) ? $rows[$index]['_labels'] : [];
                if ($sourceLabel !== null && $sourceValue !== null) {
                    $labels[$column->key] = $sourceLabel;
                } else {
                    unset($labels[$column->key]);
                }
                $rows[$index]['_labels'] = $labels;
                $rowPatch['_labels'] = $labels;
            }
            // A fill IS a cell change: the grid's afterCellChange hook runs per target row so
            // row-consistency rules (e.g. the voucher's typed-side-wins) hold under Ctrl+D too —
            // without this a fill could bypass an invariant every typed commit enforces.
            $rows[$index] = $this->runCellHook($grid, $rows[$index], $column->key, $rowPatch);
            $rows[$index] = $this->recomputeFormulas($grid, $rows[$index], $rowPatch);
            $patch[$key] = [$column->key => $sourceValue] + $rowPatch;
        }

        $result = ['seq' => $op->seq, 'ok' => true, 'patch' => $patch, 'errors' => []];
        $touchedRefresh = isset($refreshCols[$column->key]);

        return [$rows, $result, $touchedRefresh];
    }

    /**
     * Apply a row insert: a fresh blank row keyed by the client's `as`, placed after `after` (or
     * appended when `after` is null / not found).
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array{0: list<array<string, mixed>>, 1: OpResultShape, 2: bool}
     */
    private function applyInsert(Grid $grid, array $rows, Op $op): array
    {
        $blank = $grid->makeNewRow((string) $op->as);

        $afterIndex = $op->after !== null ? $this->indexOfKey($rows, $op->after) : null;
        if ($afterIndex === null) {
            $rows[] = $blank;
        } else {
            array_splice($rows, $afterIndex + 1, 0, [$blank]);
        }

        return [$rows, ['seq' => $op->seq, 'ok' => true, 'patch' => [], 'errors' => []], false];
    }

    /**
     * Apply a row remove — refused when it would drop below the grid's minRows (G4).
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array{0: list<array<string, mixed>>, 1: OpResultShape, 2: bool}
     */
    private function applyRemove(Grid $grid, array $rows, Op $op): array
    {
        $index = $this->indexOfKey($rows, (string) $op->row);
        if ($index === null) {
            // Already gone — idempotent success.
            return [$rows, ['seq' => $op->seq, 'ok' => true, 'patch' => [], 'errors' => []], false];
        }

        $remaining = $this->nonBlankCount($grid, $rows) - ($this->isBlankRow($grid, $rows[$index]) ? 0 : 1);
        if ($grid->getMinRows() > 0 && $remaining < $grid->getMinRows()) {
            return [$rows, $this->fail($op, '_row', 'At least '.$grid->getMinRows().' line(s) required.', $rows), false];
        }

        array_splice($rows, $index, 1);

        if ($grid->getAfterRowRemoveHook() !== null) {
            ($grid->getAfterRowRemoveHook())();
        }

        return [$rows, ['seq' => $op->seq, 'ok' => true, 'patch' => [], 'errors' => []], false];
    }

    /**
     * Apply a row duplicate: clone the source row's values under the client's new `_k`, inserted
     * immediately after the source.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array{0: list<array<string, mixed>>, 1: OpResultShape, 2: bool}
     */
    private function applyDup(Grid $grid, array $rows, Op $op): array
    {
        $index = $this->indexOfKey($rows, (string) $op->row);
        if ($index === null) {
            return [$rows, $this->fail($op, '_row', 'That row no longer exists.', $rows), false];
        }

        $clone = $rows[$index];
        $clone['_k'] = (string) $op->as;
        array_splice($rows, $index + 1, 0, [$clone]);

        return [$rows, ['seq' => $op->seq, 'ok' => true, 'patch' => [], 'errors' => []], false];
    }

    // ---- Value casting (registry-based; JS twins live in the client parse registry) --------

    /**
     * Cast a raw typed value to the column's model type through the CastRegistry — the core
     * kinds (text/int/decimal/select/bool/date) plus any app-registered kinds. Every cast
     * mirrors its JS parse twin so the optimistic client value and the authoritative server
     * value agree (R2); unknown kinds fall back to the text cast in BOTH runtimes.
     */
    private function castValue(Column $column, mixed $value): mixed
    {
        $spec = $column->parseSpec();

        return $this->casts->cast((string) ($spec['kind'] ?? 'text'), $value, $spec, $column);
    }

    // ---- Validation -----------------------------------------------------------------------

    /**
     * Validate a cast cell against the column's server ruleset. Returns the messages (empty = ok).
     *
     * @param  array<string, mixed>  $row
     * @return list<string>
     */
    private function validateCell(Column $column, array $row, mixed $value): array
    {
        $rules = $this->ruleCompiler->serverRules($column, $row);
        // Nothing to check beyond "nullable" → skip building a validator.
        if ($rules === ['nullable']) {
            return [];
        }

        $validator = Validator::make(
            [$column->key => $value === '' ? null : $value],
            [$column->key => $rules],
        );

        // errors()->get() returns list<string> for a single key; map to be certain it's flat strings.
        return array_values(array_map(
            fn ($message): string => is_array($message) ? (string) ($message[0] ?? '') : (string) $message,
            $validator->errors()->get($column->key),
        ));
    }

    // ---- Hooks + formulas -----------------------------------------------------------------

    /**
     * Store (or clear) a pick's display label in the row's `_labels` bag. Client-echoed and
     * display-only (M5 decision 2): it lives in the host prop so a host re-render keeps painting
     * the label, but RowSerializer strips it at save — the validated VALUE is what persists.
     *
     * @param  array<string, mixed>  $row
     * @return array<string, mixed>
     */
    private function applyPickLabel(Column $column, array $row, Op $op): array
    {
        if (($column->parseSpec()['kind'] ?? null) !== 'select') {
            return $row;
        }

        /** @var array<string, string> $labels */
        $labels = is_array($row['_labels'] ?? null) ? $row['_labels'] : [];

        if (($row[$column->key] ?? null) !== null && $op->label !== null) {
            $labels[$column->key] = $op->label;
        } else {
            // A cleared pick, or a value written WITHOUT a label (a pasted raw id): any previous
            // label no longer describes the value — drop it rather than mislabel.
            unset($labels[$column->key]);
        }

        $row['_labels'] = $labels;

        return $row;
    }

    /**
     * Run a SearchSelectColumn's onSelect enrichment hook via a RowContext — the generalised
     * "item pick pre-fills uom/tax/rate" seam (umbrella §2.5.3). Fires on every applied set to
     * the column, including a clear (value null), so a hook can also reset its dependents.
     *
     * @param  array<string, mixed>  $row
     * @param  array<string, mixed>  $patch  (by ref) accumulates write-backs
     * @return array<string, mixed>
     */
    private function runSelectHook(Column $column, array $row, mixed $value, array &$patch): array
    {
        if (! $column instanceof SearchSelectColumn || $column->getOnSelectHook() === null) {
            return $row;
        }

        $context = new RowContext($row);
        ($column->getOnSelectHook())($context, $value);

        foreach ($context->touched() as $key) {
            $patch[$key] = $context->get($key);
        }

        return $context->row();
    }

    /**
     * Run the grid's afterCellChange hook (if any) via a RowContext, folding the hook's writes
     * into the response patch.
     *
     * @param  array<string, mixed>  $row
     * @param  array<string, mixed>  $patch  (by ref) accumulates write-backs
     * @return array<string, mixed>
     */
    private function runCellHook(Grid $grid, array $row, string $column, array &$patch): array
    {
        $hook = $grid->getAfterCellChangeHook();
        if ($hook === null) {
            return $row;
        }

        $context = new RowContext($row);
        $hook($context, $column);

        foreach ($context->touched() as $key) {
            $patch[$key] = $context->get($key);
        }

        return $context->row();
    }

    /**
     * Recompute every FormulaColumn over the row and fold changed values into the patch. Formulas
     * are the authoritative derived values (the client computed them optimistically; the server
     * value wins on reconcile).
     *
     * @param  array<string, mixed>  $row
     * @param  array<string, mixed>  $patch  (by ref) accumulates changed formula values
     * @return array<string, mixed>
     */
    private function recomputeFormulas(Grid $grid, array $row, array &$patch): array
    {
        foreach ($grid->getColumns() as $column) {
            if (! $column instanceof FormulaColumn) {
                continue;
            }
            $value = $this->evaluator->evaluate($column->ast(), $row);
            if (($row[$column->key] ?? null) !== $value) {
                $row[$column->key] = $value;
                $patch[$column->key] = $value;
            }
        }

        return $row;
    }

    // ---- Footer + blank-row helpers -------------------------------------------------------

    /**
     * Recompute footer aggregates over the applied rows (blank trailing rows excluded, G4).
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array<string, int|float|string>
     */
    private function computeFooter(Grid $grid, array $rows): array
    {
        $counted = $this->rowsForTotals($grid, $rows);
        $footer = [];
        foreach ($grid->getFooter() as $aggregate) {
            $footer[$aggregate->column] = $aggregate->compute($counted);
        }

        return $footer;
    }

    /**
     * The rows counted for validation/footer: all but any blank trailing rows created by auto-append.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    private function rowsForTotals(Grid $grid, array $rows): array
    {
        $out = $rows;
        while ($out !== [] && $this->isBlankRow($grid, end($out))) {
            array_pop($out);
        }

        return $out;
    }

    /**
     * Whether the row at $index is a blank trailing row (blank AND nothing non-blank follows it).
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function isBlankTrailing(Grid $grid, array $rows, int $index): bool
    {
        if (! $this->isBlankRow($grid, $rows[$index])) {
            return false;
        }
        for ($i = $index + 1; $i < count($rows); $i++) {
            if (! $this->isBlankRow($grid, $rows[$i])) {
                return false;
            }
        }

        return true;
    }

    /**
     * A row is blank when every editable column still matches the fresh-row TEMPLATE
     * (newRowUsing() defaults included) — factory defaults alone are not operator data.
     * Columns the template leaves null fall back to the classic empty check (null / '' /
     * 0 / '0' / false). Non-editable carried values (ids, formulas) never count.
     *
     * @param  array<string, mixed>  $row
     */
    private function isBlankRow(Grid $grid, array $row): bool
    {
        $template = $grid->newRowTemplate();

        foreach ($grid->getColumns() as $column) {
            if (! $column->isEditable()) {
                continue;
            }
            $value = $row[$column->key] ?? null;
            $default = $template[$column->key] ?? null;

            if ($default !== null) {
                // Loose comparison bridges cast/hydration boundaries ('1' == 1).
                if ($value != $default && $value !== null && $value !== '') {
                    return false;
                }

                continue;
            }

            if ($value !== null && $value !== '' && $value !== 0 && $value !== '0' && $value !== false) {
                return false;
            }
        }

        return true;
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     */
    private function nonBlankCount(Grid $grid, array $rows): int
    {
        $count = 0;
        foreach ($rows as $row) {
            if (! $this->isBlankRow($grid, $row)) {
                $count++;
            }
        }

        return $count;
    }


    // ---- Small utilities ------------------------------------------------------------------

    /**
     * The array index of the row bearing `_k` = $key, or null.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function indexOfKey(array $rows, string $key): ?int
    {
        foreach ($rows as $i => $row) {
            if (($row['_k'] ?? null) === $key) {
                return $i;
            }
        }

        return null;
    }

    /**
     * Build a failed op result carrying one error under a row/column key.
     *
     * A STRUCTURAL failure (stale row ref, minRows refusal) also attaches the authoritative
     * `rows` snapshot: the client applied the op optimistically, so its row STRUCTURE has
     * drifted from the server's — the snapshot lets it roll back wholesale (P6; closes the
     * review-found minRows drift defect). Cell-level failures (validation, not-editable)
     * never attach rows: the error/dirty marks on the cell are the correct UX there.
     *
     * @param  list<array<string, mixed>>|null  $resyncRows
     * @return OpResultShape
     */
    private function fail(Op $op, string $key, string $message, ?array $resyncRows = null): array
    {
        $rowKey = $op->row ?? '_row';

        $result = [
            'seq' => $op->seq,
            'ok' => false,
            'patch' => [],
            'errors' => [$rowKey => [$key => $message]],
        ];

        if ($resyncRows !== null) {
            $result['rows'] = $resyncRows;
        }

        return $result;
    }
}
