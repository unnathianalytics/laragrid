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
use LaraGrid\Support\RowSerializer;
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
 * @phpstan-type OpResultShape array{seq: int, ok: bool, conflict?: bool, patch: array<string, array<string, mixed>>, errors: array<string, array<string, string>>, rows?: list<array<string, mixed>>}
 */
class OpApplier
{
    // ---- Batch context ------------------------------------------------------------------------
    //
    // Set at the start of apply() and cleared at its end. A draft restore is N rows x C columns
    // of SET ops; without these, every op paid an O(N) key scan and every blank check rebuilt
    // the fresh-row template and re-walked the rows after it.

    /**
     * Row `_k` => array index, rebuilt by the structural ops (insert/remove/dup).
     *
     * @var array<string, int>
     */
    private array $indexByKey = [];

    /**
     * The grid's fresh-row template, the reference every blank check compares against.
     *
     * @var array<string, mixed>|null
     */
    private ?array $template = null;

    /**
     * Blank verdict per row `_k`, dropped for a row whenever an op writes into it.
     *
     * @var array<string, bool>
     */
    private array $blankByKey = [];

    /**
     * Index of the last non-blank row: -1 when every row is blank, null when unknown (recomputed
     * lazily after a structural op). "Row i is blank trailing" is simply i > this.
     */
    private ?int $lastNonBlank = null;

    /**
     * Paste-by-label resolutions for this batch, keyed by column, pasted text and the picker's
     * optionsDependOn() values — a label pasted down fifty rows runs the closure once.
     *
     * @var array<string, list<array{value: string, label: string, meta?: string}>>
     */
    private array $lookupMemo = [];

    /** Whether the grid tracks a change set (->trackChanges(), F6) — set per batch. */
    private bool $tracking = false;

    /**
     * Keys this batch inserted or duplicated (change tracking only).
     *
     * @var list<string>
     */
    private array $insertedKeys = [];

    /**
     * Rows this batch removed, as they were just before removal (change tracking only).
     *
     * @var list<array<string, mixed>>
     */
    private array $removedRows = [];

    public function __construct(
        private readonly RuleCompiler $ruleCompiler = new RuleCompiler,
        private readonly Evaluator $evaluator = new Evaluator,
        private readonly CastRegistry $casts = new CastRegistry,
        private readonly RowSerializer $serializer = new RowSerializer,
    ) {}

    /**
     * Apply a batch to a copy of the grid's rows.
     *
     * @param  list<array<string, mixed>>  $rows  The host's current rows (each carrying `_k`).
     * @param  int  $version  The grid's current server version.
     */
    public function apply(Grid $grid, array $rows, OpBatch $batch, int $version = 0): OpResult
    {
        $this->beginBatch($grid, $rows);

        try {
            return $this->applyBatch($grid, $rows, $batch, $version);
        } finally {
            $this->endBatch();
        }
    }

    /**
     * @param  list<array<string, mixed>>  $rows
     */
    private function applyBatch(Grid $grid, array $rows, OpBatch $batch, int $version): OpResult
    {
        if ($batch->baseVersion !== $version) {
            $results = [];
            foreach ($batch->ops as $op) {
                $rowKey = $op->row ?? '_grid';
                $colKey = $op->col ?? '_row';
                $results[] = [
                    'seq' => $op->seq,
                    'ok' => false,
                    'conflict' => true,
                    'patch' => [],
                    'errors' => [
                        $rowKey => [
                            $colKey => 'This grid changed in another request. Review the latest values and try again.',
                        ],
                    ],
                ];
            }

            return new OpResult(
                version: $version,
                results: $results,
                footer: $this->computeFooter($grid, $rows),
                rows: $rows,
                refreshHost: false,
            );
        }

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
            inserted: $this->insertedKeys,
            removed: $this->removedRows,
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
            Op::MOVE => $this->applyMove($rows, $op),
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
        $index = $this->indexOfKey((string) $op->row);
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

        // Paste by label (F3): a server-mode picker resolves the pasted text to exactly one
        // option id before the cast; none or several refuse the write and leave the row as it was.
        $value = $op->value;
        $label = $op->label;
        $resolved = false;
        if ($op->lookup && $column instanceof SearchSelectColumn && $column->hasServerOptions()) {
            $text = trim(is_scalar($op->value) ? (string) $op->value : '');
            if ($text !== '') {
                $hits = $this->lookupOptions($column, $text, $rows[$index]);
                if (count($hits) !== 1) {
                    $message = $hits === []
                        ? "No option matches \"{$text}\"."
                        : "\"{$text}\" matches ".count($hits).' options; pick it from the list.';

                    return [$rows, $this->fail($op, $column->key, $message), false];
                }
                [$value, $label, $resolved] = [$hits[0]['value'], $hits[0]['label'], true];
            }
        }

        $classesBefore = $this->classesOf($grid, $rows[$index]);
        $before = $this->tracking ? $rows[$index] : null;
        $cast = $this->castValue($column, $value);
        $rows[$index][$column->key] = $cast;
        $this->rowChanged($grid, $rows, $index);

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
            $rows[$index] = $this->applyPickLabel($column, $rows[$index], $label);
            $rows[$index] = $this->runSelectHook($column, $rows[$index], $cast, $patch);
            $rows[$index] = $this->runCellHook($grid, $rows[$index], $column->key, $patch);
            $rows[$index] = $this->recomputeFormulas($grid, $rows[$index], $patch);
            // A hook may have written other editable cells of this row.
            $this->rowChanged($grid, $rows, $index);
        }
        if ($resolved) {
            // The client holds the pasted text: hand it the resolved id and its label.
            $rows[$index] = $this->applyPickLabel($column, $rows[$index], $label);
            $patch[$column->key] = $cast;
            $patch['_labels'] = array_merge(
                is_array($patch['_labels'] ?? null) ? $patch['_labels'] : [],
                [$column->key => $label],
            );
        }
        $this->patchClasses($grid, $rows[$index], $classesBefore, $patch);
        if ($before !== null) {
            $rows[$index] = $this->trackOriginals($grid, $before, $rows[$index]);
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
        $sourceIndex = $this->indexOfKey($keys[0]);
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
        $resultErrors = [];
        foreach (array_slice($keys, 1) as $key) {
            $index = $this->indexOfKey($key);
            if ($index === null) {
                $resultErrors[$key][$column->key] = 'That row no longer exists.';

                continue;
            }
            if ($column->isReadonlyFor($rows[$index])) {
                $resultErrors[$key][$column->key] = 'This cell is not editable.';

                continue;
            }
            $classesBefore = $this->classesOf($grid, $rows[$index]);
            $before = $this->tracking ? $rows[$index] : null;
            $rows[$index][$column->key] = $sourceValue;
            $this->rowChanged($grid, $rows, $index);
            $rowPatch = [];
            $validation = $this->isBlankTrailing($grid, $rows, $index)
                ? []
                : $this->validateCell($column, $rows[$index], $sourceValue);
            if ($validation !== []) {
                $resultErrors[$key][$column->key] = $validation[0];
                $this->patchClasses($grid, $rows[$index], $classesBefore, $rowPatch);
                if ($before !== null) {
                    $rows[$index] = $this->trackOriginals($grid, $before, $rows[$index]);
                }
                $patch[$key] = [$column->key => $sourceValue] + $rowPatch;

                continue;
            }
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
            $this->rowChanged($grid, $rows, $index);
            $this->patchClasses($grid, $rows[$index], $classesBefore, $rowPatch);
            if ($before !== null) {
                $rows[$index] = $this->trackOriginals($grid, $before, $rows[$index]);
            }
            $patch[$key] = [$column->key => $sourceValue] + $rowPatch;
        }

        $result = [
            'seq' => $op->seq,
            'ok' => $resultErrors === [],
            'patch' => $patch,
            'errors' => $resultErrors,
        ];
        $touchedRefresh = isset($refreshCols[$column->key]);

        return [$rows, $result, $touchedRefresh];
    }

    /**
     * Remember the original value of every writable cell this write changed (change tracking,
     * F6): the first change of a cell records `_orig[col]`; later changes keep it, so `_orig`
     * always holds the value the row had at the baseline.
     *
     * @param  array<string, mixed>  $before  The row just before the op.
     * @param  array<string, mixed>  $after  The row after the op, its hooks and formulas.
     * @return array<string, mixed>
     */
    private function trackOriginals(Grid $grid, array $before, array $after): array
    {
        $originals = is_array($after['_orig'] ?? null) ? $after['_orig'] : [];
        foreach ($grid->getColumns() as $column) {
            if (! $column->isWritable() || array_key_exists($column->key, $originals)) {
                continue;
            }
            $old = $before[$column->key] ?? null;
            if ($old !== ($after[$column->key] ?? null)) {
                $originals[$column->key] = $old;
            }
        }
        if ($originals !== []) {
            $after['_orig'] = $originals;
        }

        return $after;
    }

    /**
     * The options a pasted label names on a server-mode picker, memoised per batch by column,
     * the exact pasted text (an id matches case-sensitively) and the row's optionsDependOn()
     * values (taken from the row as earlier ops in the batch left it).
     *
     * @param  array<string, mixed>  $row
     * @return list<array{value: string, label: string, meta?: string}>
     */
    private function lookupOptions(SearchSelectColumn $column, string $text, array $row): array
    {
        $dependencies = [];
        foreach ($column->getOptionsDependOn() as $key) {
            $dependencies[$key] = $row[$key] ?? null;
        }
        $memoKey = $column->key."\x1F".$text."\x1F".json_encode($dependencies);

        return $this->lookupMemo[$memoKey] ??= $column->resolveExact($text, $row);
    }

    /**
     * The closure-resolved classes of a row before a write, or null when the grid declares no
     * rowClass()/cellClass() closure (the common case pays nothing).
     *
     * @param  array<string, mixed>  $row
     * @return array{_rowClass?: string, _cellClass?: array<string, string>}|null
     */
    private function classesOf(Grid $grid, array $row): ?array
    {
        return $grid->hasClassResolvers() ? $this->serializer->rowClasses($grid, $row) : null;
    }

    /**
     * Refresh the closure classes in a row's write-back patch: re-run the resolvers over the
     * written row and add `_rowClass` (string, or null when it went away) and `_cellClass` (the
     * row's whole column => class map; an empty list when none is left) only when they differ
     * from the verdict before the write.
     *
     * @param  array<string, mixed>  $row
     * @param  array{_rowClass?: string, _cellClass?: array<string, string>}|null  $before
     * @param  array<string, mixed>  $patch
     */
    private function patchClasses(Grid $grid, array $row, ?array $before, array &$patch): void
    {
        if ($before === null) {
            return;
        }
        $after = $this->serializer->rowClasses($grid, $row);

        if (($before['_rowClass'] ?? null) !== ($after['_rowClass'] ?? null)) {
            $patch['_rowClass'] = $after['_rowClass'] ?? null;
        }
        if (($before['_cellClass'] ?? []) !== ($after['_cellClass'] ?? [])) {
            $patch['_cellClass'] = $after['_cellClass'] ?? [];
        }
    }

    /**
     * Apply a row insert: a fresh blank row keyed by the client's `as`, placed before `before`
     * when given (undo restoring a removed row at its original position — `after` alone cannot
     * express "first row"), else after `after`, else appended.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array{0: list<array<string, mixed>>, 1: OpResultShape, 2: bool}
     */
    private function applyInsert(Grid $grid, array $rows, Op $op): array
    {
        if ($this->indexOfKey((string) $op->as) !== null) {
            // Applied-but-lost responses are safe to retry: the echoed key is the idempotency key.
            return [$rows, ['seq' => $op->seq, 'ok' => true, 'patch' => [], 'errors' => []], false];
        }
        $blank = $grid->makeNewRow((string) $op->as);

        $beforeIndex = $op->before !== null ? $this->indexOfKey($op->before) : null;
        $afterIndex = $op->after !== null ? $this->indexOfKey($op->after) : null;
        if ($beforeIndex !== null) {
            array_splice($rows, $beforeIndex, 0, [$blank]);
        } elseif ($afterIndex === null) {
            $rows[] = $blank;
        } else {
            array_splice($rows, $afterIndex + 1, 0, [$blank]);
        }
        $this->reindex($rows);
        if ($this->tracking) {
            $this->insertedKeys[] = (string) $op->as;
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
        $index = $this->indexOfKey((string) $op->row);
        if ($index === null) {
            // Already gone — idempotent success.
            return [$rows, ['seq' => $op->seq, 'ok' => true, 'patch' => [], 'errors' => []], false];
        }

        $remaining = $this->nonBlankCount($grid, $rows) - ($this->isBlankRow($grid, $rows[$index]) ? 0 : 1);
        if ($grid->getMinRows() > 0 && $remaining < $grid->getMinRows()) {
            return [$rows, $this->fail($op, '_row', 'At least '.$grid->getMinRows().' line(s) required.', $rows), false];
        }

        if ($this->tracking) {
            $this->removedRows[] = $rows[$index];
        }
        array_splice($rows, $index, 1);
        unset($this->blankByKey[(string) $op->row]);
        $this->reindex($rows);

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
        if ($this->indexOfKey((string) $op->as) !== null) {
            return [$rows, ['seq' => $op->seq, 'ok' => true, 'patch' => [], 'errors' => []], false];
        }
        $index = $this->indexOfKey((string) $op->row);
        if ($index === null) {
            return [$rows, $this->fail($op, '_row', 'That row no longer exists.', $rows), false];
        }

        $clone = $rows[$index];
        $clone['_k'] = (string) $op->as;
        unset($clone['_orig']); // a copy is a new row: it has no originals of its own
        array_splice($rows, $index + 1, 0, [$clone]);
        $this->reindex($rows);
        if ($this->tracking) {
            $this->insertedKeys[] = (string) $op->as;
        }

        return [$rows, ['seq' => $op->seq, 'ok' => true, 'patch' => [], 'errors' => []], false];
    }

    /**
     * Apply a row move (F4): take the row out and put it back before `before`, else after
     * `after`, else at the end — the anchors resolve among the OTHER rows, with insert's
     * semantics. An unknown row or anchor means the client and server disagree on structure, so
     * the failure carries the authoritative rows for a rollback. A move onto the row's own
     * position is an idempotent success.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array{0: list<array<string, mixed>>, 1: OpResultShape, 2: bool}
     */
    private function applyMove(array $rows, Op $op): array
    {
        $index = $this->indexOfKey((string) $op->row);
        if ($index === null) {
            return [$rows, $this->fail($op, '_row', 'That row no longer exists.', $rows), false];
        }

        // Anchor index among the rows that remain once the moved row is taken out.
        $anchorKey = $op->before ?? $op->after;
        $target = count($rows) - 1;
        if ($anchorKey !== null) {
            $anchor = $this->indexOfKey($anchorKey);
            if ($anchor === null || $anchor === $index) {
                return [$rows, $this->fail($op, '_row', 'The row to move beside no longer exists.', $rows), false];
            }
            $target = ($anchor > $index ? $anchor - 1 : $anchor) + ($op->before !== null ? 0 : 1);
        }

        if ($target !== $index) {
            $moved = array_splice($rows, $index, 1);
            array_splice($rows, $target, 0, $moved);
            // reindex() also forgets the last-non-blank marker: a blank trailing row moved up
            // is no longer trailing, so the next blank-trailing test must rescan.
            $this->reindex($rows);
        }

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

        $input = $row;
        $input[$column->key] = $value === '' ? null : $value;
        $validator = Validator::make(
            $input,
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
    private function applyPickLabel(Column $column, array $row, ?string $label): array
    {
        if (($column->parseSpec()['kind'] ?? null) !== 'select') {
            return $row;
        }

        /** @var array<string, string> $labels */
        $labels = is_array($row['_labels'] ?? null) ? $row['_labels'] : [];

        if (($row[$column->key] ?? null) !== null && $label !== null) {
            $labels[$column->key] = $label;
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
        return array_slice($rows, 0, $this->lastNonBlankIndex($grid, $rows) + 1);
    }

    /**
     * Whether the row at $index is a blank trailing row (blank AND nothing non-blank follows it)
     * — i.e. it sits after the last non-blank row.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function isBlankTrailing(Grid $grid, array $rows, int $index): bool
    {
        return $index > $this->lastNonBlankIndex($grid, $rows);
    }

    /**
     * A row is blank when every editable column still matches the fresh-row TEMPLATE
     * (newRowUsing() defaults included) — factory defaults alone are not operator data.
     * Columns the template leaves null fall back to the classic empty check (null / '' /
     * 0 / '0' / false). Non-editable carried values (ids, formulas) never count.
     *
     * The verdict is cached per `_k` for the batch; rowChanged() drops it when an op writes
     * into the row.
     *
     * @param  array<string, mixed>  $row
     */
    private function isBlankRow(Grid $grid, array $row): bool
    {
        $key = isset($row['_k']) ? (string) $row['_k'] : null;
        if ($key !== null && isset($this->blankByKey[$key])) {
            return $this->blankByKey[$key];
        }

        $template = $this->template ??= $grid->newRowTemplate();
        $blank = true;

        foreach ($grid->getColumns() as $column) {
            if (! $column->isEditable()) {
                continue;
            }
            $value = $row[$column->key] ?? null;
            $default = $template[$column->key] ?? null;

            if ($default !== null) {
                // Loose comparison bridges cast/hydration boundaries ('1' == 1).
                if ($value != $default && $value !== null && $value !== '') {
                    $blank = false;
                    break;
                }

                continue;
            }

            if ($value !== null && $value !== '' && $value !== 0 && $value !== '0' && $value !== false) {
                $blank = false;
                break;
            }
        }

        if ($key !== null) {
            $this->blankByKey[$key] = $blank;
        }

        return $blank;
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

    // ---- Batch context lifecycle ----------------------------------------------------------

    /**
     * @param  list<array<string, mixed>>  $rows
     */
    private function beginBatch(Grid $grid, array $rows): void
    {
        $this->template = $grid->newRowTemplate();
        $this->blankByKey = [];
        $this->lastNonBlank = null;
        $this->lookupMemo = [];
        $this->tracking = $grid->tracksChanges();
        $this->insertedKeys = [];
        $this->removedRows = [];
        $this->reindex($rows);
    }

    private function endBatch(): void
    {
        $this->indexByKey = [];
        $this->template = null;
        $this->blankByKey = [];
        $this->lastNonBlank = null;
        $this->lookupMemo = [];
        $this->tracking = false;
        $this->insertedKeys = [];
        $this->removedRows = [];
    }

    /**
     * Rebuild the `_k` => index map after a structural op; the last-non-blank index is
     * recomputed on its next use.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function reindex(array $rows): void
    {
        $this->indexByKey = [];
        foreach ($rows as $i => $row) {
            if (isset($row['_k'])) {
                $this->indexByKey[(string) $row['_k']] ??= $i;
            }
        }
        $this->lastNonBlank = null;
    }

    /**
     * An op wrote into the row at $index: forget its blank verdict and move the last-non-blank
     * marker if the write changed which row that is.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function rowChanged(Grid $grid, array $rows, int $index): void
    {
        if (isset($rows[$index]['_k'])) {
            unset($this->blankByKey[(string) $rows[$index]['_k']]);
        }

        if ($this->lastNonBlank === null) {
            return; // unknown anyway; the next lastNonBlankIndex() call rescans
        }

        if (! $this->isBlankRow($grid, $rows[$index])) {
            $this->lastNonBlank = max($this->lastNonBlank, $index);
        } elseif ($index === $this->lastNonBlank) {
            $this->lastNonBlank = $this->scanLastNonBlank($grid, $rows, $index - 1);
        }
    }

    /**
     * The index of the last non-blank row (-1 when every row is blank), memoised for the batch.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function lastNonBlankIndex(Grid $grid, array $rows): int
    {
        return $this->lastNonBlank ??= $this->scanLastNonBlank($grid, $rows, count($rows) - 1);
    }

    /**
     * Walk back from $from to the first non-blank row. Cheap in practice: a grid carries only
     * a few trailing blanks, so the walk stops almost immediately.
     *
     * @param  list<array<string, mixed>>  $rows
     */
    private function scanLastNonBlank(Grid $grid, array $rows, int $from): int
    {
        for ($i = $from; $i >= 0; $i--) {
            if (! $this->isBlankRow($grid, $rows[$i])) {
                return $i;
            }
        }

        return -1;
    }

    // ---- Small utilities ------------------------------------------------------------------

    /**
     * The array index of the row bearing `_k` = $key, or null — an O(1) read of the batch's
     * key map that the structural ops keep current.
     */
    private function indexOfKey(string $key): ?int
    {
        return $this->indexByKey[$key] ?? null;
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
