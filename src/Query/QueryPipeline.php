<?php

declare(strict_types=1);

namespace LaraGrid\Query;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use LaraGrid\Grid;
use LaraGrid\Support\RowSerializer;

/**
 * What: Runs a readonly grid's host-supplied query through sort → global-search → filters, then
 *       computes grand totals over the filtered set, paginates, serializes the page's rows for the
 *       client, computes page totals, and returns a PageResult.
 *
 * Why:  This is the readonly data path (plan §2.3/§2.5.4). All narrowing is server-authoritative
 *       and whitelisted (AppliesSort/Search/Filters) so the gridFetch RPC is injection-closed
 *       (G12). Grand totals are aggregated on a *clone of the filtered* query BEFORE pagination
 *       (the register total), page totals from the returned rows — both shipped so a paginated
 *       footer is honest. Rows are shaped by the SAME RowSerializer the config's first page uses,
 *       so the client row shape is identical across a page swap (no selection/paint drift).
 *
 * When: Invoked by WithLaraGrid::gridFetch (each sort/search/filter/page change) and by
 *       ConfigSerializer for the first page at render.
 */
final class QueryPipeline
{
    public function __construct(
        private readonly AppliesSort $sort = new AppliesSort,
        private readonly AppliesSearch $search = new AppliesSearch,
        private readonly AppliesFilters $filters = new AppliesFilters,
        private readonly RowSerializer $rowSerializer = new RowSerializer,
    ) {}

    /**
     * @param  array{sort?: string|null, dir?: string|null, search?: string|null, filters?: array<string, mixed>, page?: int|string|null, perPage?: int|string|null}  $request
     */
    public function run(Grid $grid, array $request): PageResult
    {
        $query = $grid->resolveQuery();

        // 1. Narrow (order/search/filter) — grand totals must see the filtered set, so search +
        //    filters run before the aggregate clone; sort is order-only and harmless either way.
        $this->sort->apply($query, $grid, $request);
        $this->search->apply($query, $grid, $request);
        $this->filters->apply($query, $grid, $request);

        // 2. Totals over the whole filtered set (before pagination) — the register total.
        $grandTotals = $this->aggregate($grid, clone $query);

        // 3. Count + paginate.
        $total = (clone $query)->toBase()->getCountForPagination();

        $perPage = $this->resolvePerPage($grid, $request);

        // Adaptive single-page (->singlePageUpTo): when the FILTERED set fits the
        // threshold, serve everything as ONE page — lastPage becomes 1 and the pagination
        // chrome self-hides client-side. Decided per request, so a narrowing search flips
        // a 73k register into the chrome-free view automatically; above the threshold the
        // declared page size applies unchanged.
        $threshold = $grid->getSinglePageUpTo();
        if ($threshold !== null && $total <= $threshold) {
            $perPage = max(1, $total);
        }

        $page = $this->resolvePage($request, $total, $perPage);

        $models = $query
            ->forPage($page, $perPage)
            ->get();

        // 4. Serialize the page's rows for the client (same shape as the config's first page).
        $rows = $this->rowSerializer->serializeMany($grid, $models);

        // 5. Page totals over just this page's rows.
        $pageTotals = $this->totalsFromRows($grid, $rows);

        return new PageResult(
            rows: $rows,
            total: $total,
            page: $page,
            perPage: $perPage,
            pageTotals: $pageTotals,
            grandTotals: $grandTotals,
        );
    }

    /**
     * Aggregate each footer column over a (filtered) query without loading rows — a SUM per
     * summable footer column, so grand totals stay exact and cheap on large sets.
     *
     * @param  Builder<covariant Model>  $query
     * @return array<string, int|float>
     */
    private function aggregate(Grid $grid, Builder $query): array
    {
        $totals = [];

        foreach ($grid->getFooter() as $aggregate) {
            if ($aggregate->type !== 'sum') {
                continue;
            }
            $sum = (clone $query)->sum($aggregate->column);
            // Keep integer paise as int; only a genuinely fractional sum becomes float.
            $totals[$aggregate->column] = $this->normaliseNumeric($sum);
        }

        return $totals;
    }

    /**
     * Page totals: re-use Aggregate::compute over the already-serialized page rows so page and
     * grand totals share the exact same summation semantics.
     *
     * @param  list<array<string, mixed>>  $rows
     * @return array<string, int|float>
     */
    private function totalsFromRows(Grid $grid, array $rows): array
    {
        $totals = [];

        foreach ($grid->getFooter() as $aggregate) {
            $totals[$aggregate->column] = $aggregate->compute($rows);
        }

        return $totals;
    }

    private function normaliseNumeric(int|float|string|null $value): int|float
    {
        if ($value === null) {
            return 0;
        }
        if (is_string($value)) {
            $value = str_contains($value, '.') ? (float) $value : (int) $value;
        }
        if (is_float($value) && $value == (int) $value) {
            return (int) $value;
        }

        return $value;
    }

    /**
     * @param  array{perPage?: int|string|null}  $request
     */
    private function resolvePerPage(Grid $grid, array $request): int
    {
        $default = $grid->getPerPage();
        $requested = isset($request['perPage']) ? (int) $request['perPage'] : $default;

        // Only honour a requested perPage that the grid offers (else fall back to the default).
        $allowed = $grid->getPerPageOptions();
        if ($requested === $default || in_array($requested, $allowed, true)) {
            return max(1, $requested);
        }

        return max(1, $default);
    }

    /**
     * @param  array{page?: int|string|null}  $request
     */
    private function resolvePage(array $request, int $total, int $perPage): int
    {
        $page = isset($request['page']) ? (int) $request['page'] : 1;
        $lastPage = max(1, (int) ceil($total / max(1, $perPage)));

        return min(max(1, $page), $lastPage);
    }
}
