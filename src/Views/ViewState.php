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
 * When: Called by WithLaraGrid::gridViewSave before the ViewStore persists.
 */
class ViewState
{
    public const MAX_SEARCH = 200;

    public const MAX_FILTER_VALUE = 200;

    /**
     * @param  array<string, mixed>  $state  The raw client payload.
     * @return array{search: string, sort: string|null, dir: string, filters: array<string, string>, perPage: int, widths: array<string, int>, hidden: list<string>}
     */
    public function sanitize(Grid $grid, array $state): array
    {
        $columnKeys = array_flip(array_map(fn (Column $c): string => $c->key, $grid->getColumns()));
        $filterKeys = array_flip(array_map(fn (Filter $f): string => $f->key, $grid->getFilters()));

        $sort = $state['sort'] ?? null;
        $sort = is_string($sort) && isset($columnKeys[$sort]) ? $sort : null;

        $search = $state['search'] ?? '';
        $search = is_string($search) ? mb_substr($search, 0, self::MAX_SEARCH) : '';

        $filters = [];
        foreach (is_array($state['filters'] ?? null) ? $state['filters'] : [] as $key => $value) {
            if (! is_string($key) || ! isset($filterKeys[$key]) || ! is_scalar($value)) {
                continue;
            }
            $filters[$key] = mb_substr((string) $value, 0, self::MAX_FILTER_VALUE);
        }

        $options = $grid->getPerPageOptions() !== [] ? $grid->getPerPageOptions() : [$grid->getPerPage()];
        $perPage = (int) ($state['perPage'] ?? 0);
        if (! in_array($perPage, $options, true)) {
            $perPage = $grid->getPerPage();
        }

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

        return [
            'search' => $search,
            'sort' => $sort,
            'dir' => ($state['dir'] ?? null) === 'desc' ? 'desc' : 'asc',
            'filters' => $filters,
            'perPage' => $perPage,
            'widths' => $widths,
            'hidden' => $hidden,
        ];
    }
}
