<?php

declare(strict_types=1);

namespace LaraGrid\Editing;

/**
 * What: The view a grid-level validator (->validateRows()) receives: the kept rows of an
 *       editable grid in order, plus a message collector at grid, row or cell scope and a
 *       `unique()` helper for the most common cross-row rule.
 *
 * Why:  Cell rules see one value and row rules see one row; "no item twice", "at least one
 *       debit line" or "the lines must balance" need the whole set. Messages are keyed by row
 *       `_k` and column — never by position — so the same result serves the live op response
 *       (the client addresses cells by key) and the save path (WithLaraGrid maps keys to
 *       indexes for the ValidationException).
 *
 * When: Built by WithLaraGrid for gridRows() / gridChanges(), gridRestoreDraft(), and — when the
 *       validator is declared live — after every gridOps batch.
 */
final class RowsContext
{
    /**
     * @var array<string, array<string, string>> [rowKey|'_grid'][column|'_row'] => message
     */
    private array $messages = [];

    /**
     * @param  list<array<string, mixed>>  $rows  The kept rows (blank trailing rows excluded),
     *                                            each carrying `_k` and `_labels`.
     */
    public function __construct(private readonly array $rows) {}

    /**
     * The kept rows in order, each with its `_k` and `_labels` intact.
     *
     * @return list<array<string, mixed>>
     */
    public function rows(): array
    {
        return $this->rows;
    }

    /**
     * Record a message: grid scope when `$row` is null, row scope when `$column` is null, else
     * cell scope. The first message for a scope wins.
     */
    public function error(string $message, ?string $row = null, ?string $column = null): static
    {
        $rowKey = $row ?? '_grid';
        $columnKey = $row === null ? '_row' : ($column ?? '_row');
        $this->messages[$rowKey][$columnKey] ??= $message;

        return $this;
    }

    /**
     * Flag every row after the first that repeats the same value(s) in `$columns`, at the cell
     * of the first listed column. Rows whose values are all blank never count as duplicates.
     *
     * @param  string|list<string>  $columns
     */
    public function unique(string|array $columns, string $message = 'Duplicate.'): static
    {
        $columns = is_array($columns) ? $columns : [$columns];
        if ($columns === []) {
            return $this;
        }

        $seen = [];
        foreach ($this->rows as $row) {
            $values = array_map(fn (string $column): mixed => $row[$column] ?? null, $columns);
            if (array_filter($values, fn (mixed $value): bool => $value !== null && $value !== '') === []) {
                continue;
            }
            $signature = json_encode(array_map(
                fn (mixed $value): mixed => is_scalar($value) ? (string) $value : $value,
                $values,
            ));
            if (isset($seen[$signature])) {
                $this->error($message, (string) ($row['_k'] ?? ''), $columns[0]);
            } else {
                $seen[$signature] = true;
            }
        }

        return $this;
    }

    /**
     * Every recorded message, keyed [rowKey|'_grid'][column|'_row'].
     *
     * @return array<string, array<string, string>>
     */
    public function messages(): array
    {
        return $this->messages;
    }
}
