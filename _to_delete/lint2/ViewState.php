<?php

declare(strict_types=1);

namespace LaraGrid\Views;

use LaraGrid\Columns\Column;
use LaraGrid\Filters\Filter;
use LaraGrid\Grid;

/**
 * What: The saved-view state sanitizer — reduces a client-supplied state payload to the exact
 *       whitelisted shape a view may hold: {search, sort, dir, filters, perPage, widths, hidden}.
 *
 * Why:  gridViewSave is a write surface fed by the client, so its payload is untrusted input
 *       (G12): unknown keys are dropped, sort/filter/width/hidden references are validated
 *       against the grid's DECLARED columns and filters, perPage must be one of the declared
 *       options, and every string is length-capped. The stored state is therefore always
 *       replayable — and even a tampered row is harmless, because applying a view runs through
 *       the same whitelisted QueryPipeline as every fetch.
 *
 * When: Called by WithLaraGrid::gridViewSave before the ViewStore persists, and (query half
 *       only, via sanitizeQuery) by the ->persistQuery() read/write path.
 */
class ViewState
{
    public const MAX_SEARCH = 200;

    public const MAX_FILTER_VALUE = 200;

    /**
     * The QUERY half of a view — also the whole of what ->persistQuery() stores.
     *
     * Why: One whitelist, two callers (gridViewSave and the session query store), so the two
     *      persistence surfaces can never drift apart in what they accept. Beyond the shape
     *      check, each filter value is offered to its own Filter::accepts() — a value that was
     *      legal when it was stored but no longer resolves (the operator switched tenant, the
     *      referenced group was deleted) is DROPPED rather than replayed into a WHERE that
     *      silently empties the list.
     *
     * @param  array<string, mixed>  $state  The raw client / stored payload.
     * @return array{search: string, sort: string|null, dir: string, filters: array<string, string>, perPage: int}
     */
    public function sanitizeQuery(Grid $grid, array $state): array
    {
        $columnKeys = array_flip(array_map(fn (Column $c): string => $c->key, $grid->getColumns()));

        /** @var array<string, Filter> $filtersByKey */
        $filtersByKey = [];
        foreach ($grid->getFilters() as $filter) {
            $filtersByKey[$filter->key] = $filter;
        }

        $sort = $state['sort'] ?? null;
        $sort = is_string($sort) && isset($columnKeys[$sort]) ? $sort : null;

        $search = $state['search'] ?? '';
        $search = is_string($search) ? mb_substr($search, 0, self::MAX_SEARCH) : '';

        $filters = [];
        foreach (is_array($state['filters'] ?? null) ? $state['filters'] : [] as $key => $value) {
            if (! is_string($key) || ! isset($filtersByKey[$key]) || ! is_scalar($value)) {
                continue;
            }
            $value = mb_substr((string) $value, 0, self::MAX_FILTER_VALUE);
            if (! $filtersByKey[$key]->accepts($value)) {
                continue;
            }
            $filters[$key] = $value;
        }

        $options = $grid->getPerPageOptions() !== [] ? $grid->getPerPageOptions() : [$grid->getPerPage()];
        $perPage = (int) ($state['perPage'] ?? 0);
        if (! in_array($perPage, $options, true)) {
            $perPage = $grid->getPerPage();
        }

        return [
            'search' => $search,
            'sort' => $sort,
            'dir' => ($state['dir'] ?? null) === 'desc' ? 'desc' : 'asc',
            'filters' => $filters,
            'perPage' => $perPage,
        ];
    }

    /**
     * @param  array<string, mixed>  $state  The raw client payload.
     * @return array{search: string, sort: string|null, dir: string, filters: array<string, string>, perPage: int, widths: array<string, int>, hidden: list<string>}
     */
    public function sanitize(Grid $grid, array $state): array
    {
        $query = $this->sanitizeQuery($grid, $state);

        $columnKeys = array_flip(array_map(fn (Column $c): string => $c->key, $grid->getColumns()));

        $widths = [];
        foreach (is_array($state['widths'] ?? null) ? $state['widths'] : [] as $key => $width) {
            if (is_string($key) && isset($columnKeys[$key]) && is_numeric($width)) {
                $widths[$key] = max(24, min(2000, (int) $width));
            }
        }

        $hidden = [];
        foreach (is_array($state['hidden'] ?? null) ? $state['hidden'] : [] as $key) {
            if (is_string($key) && isset($columnKeys[$key]) && ! in_array($key, $hidden, true)) {
                $hidden[] = $key;
            }
        }

        // Spelled out rather than array_merge()'d so the declared return shape stays provable
        // to static analysis (and the key order committed by SavedViewsTest stays fixed).
        return [
            'search' => $query['search'],
            'sort' => $query['sort'],
            'dir' => $query['dir'],
            'filters' => $query['filters'],
            'perPage' => $query['perPage'],
            'widths' => $widths,
            'hidden' => $hidden,
        ];
    }
}
