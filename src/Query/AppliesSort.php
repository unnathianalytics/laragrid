<?php

declare(strict_types=1);

namespace LaraGrid\Query;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use LaraGrid\Grid;

/**
 * What: Applies ORDER BY to the query from a client-supplied {sort, dir}, restricted to columns
 *       the grid declared ->sortable(). Falls back to the grid's ->defaultSort() when the request
 *       carries no valid sort.
 *
 * Why:  Sort keys arrive over the gridFetch RPC — an attack surface (G12). Only a declared
 *       sortable column may order, and each maps through its ->sortColumn() (a column may sort by
 *       a different DB column, e.g. a join alias for a related name). An unknown or non-sortable
 *       key is *ignored*, never concatenated into SQL — SQL-injection-closed by construction. The
 *       direction is normalised to a strict 'asc'/'desc'.
 *
 * When: First stage of QueryPipeline (before search/filters/pagination — order is orthogonal but
 *       kept first for readability).
 */
final class AppliesSort
{
    /**
     * @param  Builder<covariant Model>  $query
     * @param  array{sort?: string|null, dir?: string|null}  $request
     */
    public function apply(Builder $query, Grid $grid, array $request): void
    {
        $requested = isset($request['sort']) ? (string) $request['sort'] : null;
        $dir = ($request['dir'] ?? null) === 'desc' ? 'desc' : 'asc';

        $sortColumn = $this->resolveSortColumn($grid, $requested);

        if ($sortColumn === null) {
            $this->applyDefault($query, $grid);

            return;
        }

        $query->orderBy($sortColumn, $dir);
    }

    /**
     * Map a requested column key to its DB sort column, but only if that column is sortable.
     * Returns null for an unknown/non-sortable key (the caller falls back to the default sort).
     */
    private function resolveSortColumn(Grid $grid, ?string $requestedKey): ?string
    {
        if ($requestedKey === null || $requestedKey === '') {
            return null;
        }

        foreach ($grid->getColumns() as $column) {
            if ($column->key === $requestedKey && $column->isSortable()) {
                return $column->sortColumn();
            }
        }

        return null;
    }

    /**
     * Apply the grid's declared default sort, if any (also restricted to a sortable column).
     *
     * @param  Builder<covariant Model>  $query
     */
    private function applyDefault(Builder $query, Grid $grid): void
    {
        $default = $grid->getDefaultSort();
        if ($default === null) {
            return;
        }

        $sortColumn = $this->resolveSortColumn($grid, $default['col']);
        if ($sortColumn === null) {
            return;
        }

        $query->orderBy($sortColumn, $default['dir'] === 'desc' ? 'desc' : 'asc');
    }
}
