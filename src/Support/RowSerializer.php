<?php

declare(strict_types=1);

namespace LaraGrid\Support;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Arr;
use LaraGrid\Columns\Column;
use LaraGrid\Columns\ComputedColumn;
use LaraGrid\Grid;

/**
 * What: The single row-shaping path: turns one host source row — an Eloquent model (server pages)
 *       or a plain array (M1 in-memory display) — into the flat client row the renderer paints:
 *       a stable `_k`, each column's resolved value, baked ComputedColumn state, and any resolved
 *       row/cell classes.
 *
 * Why:  Both the config's first page (ConfigSerializer) and every subsequent gridFetch page
 *       (QueryPipeline) MUST produce an IDENTICAL row shape — same `_k`, same value keys, same
 *       baked computeds — or the client's selection/paint drifts across a page swap (plan M3
 *       decision record). One serializer, one shape. `_k` is the grid's ->rowKey() primary-key
 *       value for a model (stable across pages), else the M1 ordinal fallback for array rows.
 *
 * When: Called by QueryPipeline::run() per page and by ConfigSerializer for the first/only page.
 */
class RowSerializer
{
    /**
     * @param  iterable<int, Model|array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    public function serializeMany(Grid $grid, iterable $rows): array
    {
        /** @var list<ComputedColumn> $computed */
        $computed = array_values(array_filter(
            $grid->getColumns(),
            fn (Column $c): bool => $c instanceof ComputedColumn,
        ));
        $rowClass = $grid->getRowClassResolver();
        $cellClass = $grid->getCellClassResolver();

        $out = [];
        $ordinal = 0;

        foreach ($rows as $row) {
            $ordinal++;
            $out[] = $this->serializeOne($grid, $row, $ordinal, $computed, $rowClass, $cellClass);
        }

        return $out;
    }

    /**
     * Shape a single source row into a client row.
     *
     * @param  Model|array<string, mixed>  $row
     * @param  list<ComputedColumn>  $computed
     * @param  (\Closure(array<string, mixed>): (string|null))|null  $rowClass
     * @param  (\Closure(mixed, array<string, mixed>, string): (string|null))|null  $cellClass
     * @return array<string, mixed>
     */
    protected function serializeOne(
        Grid $grid,
        Model|array $row,
        int $ordinal,
        array $computed,
        ?\Closure $rowClass,
        ?\Closure $cellClass,
    ): array {
        // Array rows (M1 in-memory display) pass through unchanged — every host key is preserved
        // so a readonly report can carry incidental keys the client ignores; only `_k` is
        // normalised. Model rows (server pages) emit exactly the declared column values, resolving
        // dot paths against relations/attributes (e.g. 'itemGroup.name'). Because a given grid is
        // wholly array-backed (M1) OR wholly model-backed (->query()), the shape is consistent
        // within a grid — the "identical shape across a page swap" guarantee the pipeline relies on.
        if (is_array($row)) {
            $serialized = $row;
            $serialized['_k'] = $this->rowKey($grid, $row, $ordinal);
        } else {
            $serialized = ['_k' => $this->rowKey($grid, $row, $ordinal)];
            foreach ($grid->getColumns() as $column) {
                if ($column instanceof ComputedColumn) {
                    continue;
                }
                $serialized[$column->key] = $this->resolveValue($row, $column->key);
            }
        }

        foreach ($computed as $column) {
            $serialized[$column->key] = $column->resolveState($this->toArray($row));
        }

        // Per-row activation URL (readonly master lists): resolve the host's route/permission gate
        // once and bake it as `_activateUrl` so the client can navigate on Enter / double-click
        // without ever building a URL. A null/empty return leaves the row inert (no key emitted).
        // Never emitted on an editable grid — there Enter/double-click open the editor instead.
        // Per-row actions (P7): visible url() actions bake their resolved URL; visible call()
        // actions bake `true` (the client echoes only the NAME - the server re-resolves and
        // re-authorizes on call). Invisible/inert actions emit nothing, so no button paints.
        if ($grid->getActions() !== []) {
            $bag = [];
            $asArray = $this->toArray($row);
            foreach ($grid->getActions() as $action) {
                if (! $action->isVisibleFor($asArray)) {
                    continue;
                }
                if ($action->hasUrl()) {
                    $url = $action->resolveUrl($asArray);
                    if ($url !== null) {
                        $bag[$action->name] = $url;
                    }
                } else {
                    $bag[$action->name] = true;
                }
            }
            if ($bag !== []) {
                $serialized['_actions'] = $bag;
            }
        }

        $rowActivate = $grid->getRowActivate();
        if ($rowActivate !== null && ! $grid->isEditable()) {
            $url = $rowActivate($this->toArray($row));
            if (is_string($url) && $url !== '') {
                $serialized['_activateUrl'] = $url;
            }
        }

        if ($rowClass !== null) {
            $class = $rowClass($this->toArray($row));
            if ($class !== null && $class !== '') {
                $serialized['_rowClass'] = $class;
            }
        }

        if ($cellClass !== null) {
            $cellClasses = [];
            foreach ($grid->getColumns() as $column) {
                $class = $cellClass($serialized[$column->key] ?? null, $serialized, $column->key);
                if ($class !== null && $class !== '') {
                    $cellClasses[$column->key] = $class;
                }
            }
            if ($cellClasses !== []) {
                $serialized['_cellClass'] = $cellClasses;
            }
        }

        return $serialized;
    }

    /**
     * The stable client key `_k`: the grid's rowKey PK value for a model, an explicit `_k` when a
     * host array already carries one, else a deterministic ordinal fallback ('r{n}').
     *
     * What: For an EDITABLE grid a missing `_k` is a build error, not a fallback (M7, the M6
     *       live-defect rule): the synthesised ordinal exists only in the client payload — the
     *       host property's rows don't carry it — so the very first op dies with "row no longer
     *       exists" (dead totals, no hooks, orphaned optimistic paints).
     * Why:  Throwing in local/testing catches the gap at the first render of a new host; in
     *       production it logs once and synthesises instead — a degraded live screen beats a
     *       crashed one, and the log points at the exact grid to fix.
     *
     * @param  Model|array<string, mixed>  $row
     */
    protected function rowKey(Grid $grid, Model|array $row, int $ordinal): string
    {
        if ($row instanceof Model) {
            $key = $row->getAttribute($grid->getRowKey());

            return $key !== null && $key !== '' ? (string) $key : 'r'.$ordinal;
        }

        if (isset($row['_k']) && $row['_k'] !== '') {
            return (string) $row['_k'];
        }

        if ($grid->isEditable()) {
            $message = "Grid [{$grid->name}] is editable but a bound row (ordinal {$ordinal}) carries no _k. "
                .'Seed a stable _k wherever the host creates rows (empty-line factory, mount seeding) — '
                .'e.g. \'l\'.bin2hex(random_bytes(4)).';

            if (app()->environment('local', 'testing')) {
                throw new \InvalidArgumentException($message);
            }

            // Log once per grid per process (a static guard, not the once() helper — that
            // helper only exists on Laravel 11+, and the package floor is Laravel 10).
            static $logged = [];
            if (! isset($logged[$grid->name])) {
                $logged[$grid->name] = true;
                logger()->error($message);
            }
        }

        return 'r'.$ordinal;
    }

    /**
     * Resolve a column's value from the source row, supporting dot paths on both models
     * (relations/attributes via data_get) and arrays.
     *
     * @param  Model|array<string, mixed>  $row
     */
    protected function resolveValue(Model|array $row, string $key): mixed
    {
        if ($row instanceof Model) {
            return data_get($row, $key);
        }

        return Arr::get($row, $key);
    }

    /**
     * A source row as an array, for closures/computed resolvers that expect array access. A model
     * is turned into its attributes-plus-loaded-relations array (toArray) once, lazily.
     *
     * @param  Model|array<string, mixed>  $row
     * @return array<string, mixed>
     */
    protected function toArray(Model|array $row): array
    {
        return $row instanceof Model ? $row->toArray() : $row;
    }

    /**
     * The clean rows an editable grid's host save() should persist (umbrella §3.3, gridRows()).
     *
     * What: Drops blank trailing rows (the auto-append artefact, G4) and strips the client-only
     *       bookkeeping keys (`_k`, `_rowClass`, `_cellClass`) so nothing grid-internal leaks into
     *       the saved data.
     * Why:  The host reads this — never the raw bound property — so the op protocol's stable keys
     *       and the auto-append blank row stay a pure client/transport concern. A row is "blank"
     *       when every EDITABLE column is empty, matching the OpApplier's own blank-row rule so the
     *       two never disagree on what counts.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return list<array<string, mixed>>
     */
    public function cleanEditableRows(Grid $grid, array $rows): array
    {
        // Strip blank trailing rows.
        while ($rows !== [] && $this->isBlankEditableRow($grid, end($rows))) {
            array_pop($rows);
        }

        return array_map(function (array $row): array {
            unset($row['_k'], $row['_rowClass'], $row['_cellClass'], $row['_labels'], $row['_actions']);

            return $row;
        }, $rows);
    }

    /**
     * A row is blank when every editable column is empty (null / '' / 0 / an untoggled
     * checkbox's false). Non-editable carried values (ids, formulas, readonly) don't count.
     * Mirrors OpApplier::isBlankRow().
     *
     * @param  array<string, mixed>  $row
     */
    protected function isBlankEditableRow(Grid $grid, array $row): bool
    {
        foreach ($grid->getColumns() as $column) {
            if (! $column->isEditable()) {
                continue;
            }
            $value = $row[$column->key] ?? null;
            if ($value !== null && $value !== '' && $value !== 0 && $value !== '0' && $value !== false) {
                return false;
            }
        }

        return true;
    }
}
