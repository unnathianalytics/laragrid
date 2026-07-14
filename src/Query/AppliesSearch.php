<?php

declare(strict_types=1);

namespace LaraGrid\Query;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use LaraGrid\Grid;

/**
 * What: Applies the global search term as a grouped OR of LIKE clauses across the grid's declared
 *       ->searchable() targets.
 *
 * Why:  A single search box narrowing across several columns is the register operator's reflex
 *       (name OR code). The clauses are wrapped in one where(fn) so they OR *among themselves* but
 *       AND with the surrounding filters — a search must never widen a filtered set past its
 *       filters (the classic un-grouped-OR leak). Targets come from ->searchable() (validated at
 *       build time to be real columns), so nothing client-supplied names a column; only the term
 *       is bound. An empty term is a no-op.
 *
 * When: Second stage of QueryPipeline.
 */
final class AppliesSearch
{
    /**
     * @param  Builder<covariant Model>  $query
     * @param  array{search?: string|null}  $request
     */
    public function apply(Builder $query, Grid $grid, array $request): void
    {
        $term = trim((string) ($request['search'] ?? ''));
        $targets = $grid->getSearchable();

        if ($term === '' || $targets === []) {
            return;
        }

        $like = '%'.$term.'%';

        $query->where(function (Builder $inner) use ($targets, $like): void {
            foreach ($targets as $column) {
                $inner->orWhere($column, 'like', $like);
            }
        });
    }
}
