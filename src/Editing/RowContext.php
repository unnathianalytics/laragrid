<?php

declare(strict_types=1);

namespace LaraGrid\Editing;

/**
 * What: A thin, mutable view over a single row array passed to a grid's server hooks
 *       (afterCellChange, and — from M5 — a SearchSelect column's onSelect). It offers get()/set()
 *       by column key and tracks which keys the hook wrote, so the OpApplier can fold those writes
 *       into the response's write-backs.
 *
 * Why:  A hook must be able to enrich a row (a picked item pre-filling uom_id/tax/rate — the
 *       generalisation of today's updated() magic, plan §2.5.3) without reaching into the applier's
 *       internals or mutating a raw array the applier can't see. RowContext is that boundary: the
 *       hook mutates the context; the applier reads back the row AND the touched keys to build the
 *       authoritative patch the client reconciles. Kept deliberately tiny — no query/DB access, no
 *       app knowledge — so hooks stay pure row transformations.
 *
 * When: Constructed by the OpApplier around the row an op targets, handed to the grid's hooks,
 *       then read back (row() + touched()) to collect write-backs.
 */
final class RowContext
{
    /**
     * Column keys the hook wrote via set() — the write-backs the applier returns to the client.
     *
     * @var array<string, true>
     */
    private array $touched = [];

    /**
     * @param  array<string, mixed>  $row  The current row (mutated in place by set()).
     */
    public function __construct(private array $row) {}

    /**
     * Read a column value from the row.
     */
    public function get(string $key): mixed
    {
        return $this->row[$key] ?? null;
    }

    /**
     * Write a column value; records the key as touched so it rides the response patch.
     */
    public function set(string $key, mixed $value): static
    {
        $this->row[$key] = $value;
        $this->touched[$key] = true;

        return $this;
    }

    /**
     * Label a picker column's value in the row's display-only `_labels` bag — how an enrichment
     * hook that sets e.g. `uom_id` also tells the client what to PAINT for it (the client can't
     * reverse-map an id it never searched). Marks `_labels` touched so the merged map rides the
     * response patch; the bag is stripped at save (RowSerializer) and never persists.
     */
    public function setLabel(string $key, string $label): static
    {
        $labels = is_array($this->row['_labels'] ?? null) ? $this->row['_labels'] : [];
        $labels[$key] = $label;

        $this->row['_labels'] = $labels;
        $this->touched['_labels'] = true;

        return $this;
    }

    /**
     * The full current row (after any hook mutations).
     *
     * @return array<string, mixed>
     */
    public function row(): array
    {
        return $this->row;
    }

    /**
     * The column keys the hook wrote, in write order-agnostic key form.
     *
     * @return list<string>
     */
    public function touched(): array
    {
        return array_keys($this->touched);
    }
}
