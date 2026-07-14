<?php

declare(strict_types=1);

namespace LaraGrid\Query;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use LaraGrid\Grid;

/**
 * What: Dispatches each client-supplied filter value to its declared Filter class's ->apply().
 *
 * Why:  Filters are server-authoritative (plan §3.1). The client sends a {filterKey => value} map;
 *       this stage looks up the *declared* Filter by key (a value for an undeclared key is
 *       ignored — the client can't invent a filter), skips inactive values (Filter::isActive, so a
 *       blank select is a no-op), and lets each Filter build its own bound WHERE. No client string
 *       becomes a column or an operator here.
 *
 * When: Third stage of QueryPipeline (after sort/search, before pagination).
 */
final class AppliesFilters
{
    /**
     * @param  Builder<covariant Model>  $query
     * @param  array<string, mixed>  $request  Client query payload; `filters` (if present) is an
     *                                         untrusted {filterKey => value} map — validated here.
     */
    public function apply(Builder $query, Grid $grid, array $request): void
    {
        $values = $request['filters'] ?? [];
        if (! is_array($values) || $values === []) {
            return;
        }

        foreach ($grid->getFilters() as $filter) {
            if (! array_key_exists($filter->key, $values)) {
                continue;
            }

            $value = $values[$filter->key];
            if (! $filter->isActive($value)) {
                continue;
            }

            $filter->apply($query, $value);
        }
    }
}
