<?php

declare(strict_types=1);

namespace LaraGrid\Query;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use LaraGrid\Grid;
use LaraGrid\Support\RowSerializer;
use Throwable;

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
        private readonly AppliesEagerLoads $eagerLoads = new AppliesEagerLoads,
    ) {}

    /**
     * @param  array{sort?: string|null, dir?: string|null, search?: string|null, filters?: array<string, mixed>, page?: int|string|null, perPage?: int|string|null}  $request
     * @param  int|null  $knownTotal  The filtered-set count when the caller already ran it
     *                                (ConfigSerializer's adaptive pre-count), so it is never run twice.
     */
    public function run(Grid $grid, array $request, ?int $knownTotal = null): PageResult
    {
        $query = $grid->resolveQuery();

        // 1. Narrow (search/filter) — grand totals must see the filtered set, so search + filters
        //    run before the aggregate clone. Sort is applied AFTER the clone: an ORDER BY on an
        //    aggregate is wasted work at best and a PostgreSQL error at worst.
        $this->search->apply($query, $grid, $request);
        $this->filters->apply($query, $grid, $request);

        // 2. Count + totals over the whole filtered set (before pagination) — the register total.
        [$total, $grandTotals] = $this->aggregateAndCount($grid, clone $query, $knownTotal);

        // 3. Order + paginate.
        $this->sort->apply($query, $grid, $request);

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

        $query->forPage($page, $perPage);

        // Relations behind dot-keyed columns load in one query each, not one per row.
        $added = $this->eagerLoads->apply($query, $grid);

        try {
            $models = $query->get();
        } catch (Throwable $e) {
            if ($added === []) {
                throw $e;
            }
            // A relation the eager loader cannot handle: serve the page on the lazy path.
            $this->eagerLoads->fallBack($query, $grid, $added, $e);
            $models = $query->get();
        }

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
     * How many rows the NARROWING half of a request produces, without materialising a page.
     *
     * Why: the adaptive single-page decision (ConfigSerializer) needs a count BEFORE it dares
     *      build page 1, and that count must see the same search + filters the page will —
     *      otherwise a restored ->persistQuery() state that narrows 73k rows down to 12 would
     *      still be judged "too big to inline" and deferred for nothing. Sort is skipped: it
     *      cannot change a count.
     *
     * @param  array{search?: string|null, filters?: array<string, mixed>}  $request
     */
    public function countFor(Grid $grid, array $request): int
    {
        $query = $grid->resolveQuery();

        $this->search->apply($query, $grid, $request);
        $this->filters->apply($query, $grid, $request);

        return (int) $query->toBase()->getCountForPagination();
    }

    /**
     * The filtered-set count plus every footer SUM, without loading rows.
     *
     * What: On a plain query (no GROUP BY / HAVING / DISTINCT / UNION) one statement does it all —
     *       `COUNT(*) AS lg_total, SUM(col) AS lg_sum_0, ...` — built in the exact shape Laravel's
     *       own pagination count uses (columns, orders, limit and offset stripped, with their
     *       bindings), so a host select() list can never leak into the aggregate. Grouped,
     *       distinct or unioned queries keep the one-COUNT-plus-K-SUMs path, whose per-query
     *       semantics Laravel already defines for those shapes.
     * Why:  K footer sums used to cost K + 1 round trips per page, each SUM dragging the page's
     *       ORDER BY along. Column names are quoted through the grammar and aliased by index so a
     *       column named like a reserved word (or `total`) can neither break nor shadow anything.
     *
     * @param  Builder<covariant Model>  $query  A clone the caller does not reuse.
     * @return array{0: int, 1: array<string, int|float>}
     */
    private function aggregateAndCount(Grid $grid, Builder $query, ?int $knownTotal): array
    {
        $query->reorder();

        $sumColumns = [];
        foreach ($grid->getFooter() as $aggregate) {
            if ($aggregate->type === 'sum') {
                $sumColumns[] = $aggregate->column;
            }
        }

        $base = $query->toBase();

        if ($sumColumns === []) {
            return [$knownTotal ?? (int) $base->getCountForPagination(), []];
        }

        $combinable = empty($base->groups) && empty($base->havings) && ! $base->distinct && empty($base->unions);

        if (! $combinable) {
            $total = $knownTotal ?? (int) $base->getCountForPagination();
            $totals = [];
            foreach ($sumColumns as $column) {
                $totals[$column] = $this->normaliseNumeric((clone $query)->sum($column));
            }

            return [$total, $totals];
        }

        $grammar = $base->getGrammar();
        $selects = ['COUNT(*) AS lg_total'];
        foreach ($sumColumns as $i => $column) {
            $selects[] = 'SUM('.$grammar->wrap($column).') AS lg_sum_'.$i;
        }

        $row = $base
            ->cloneWithout(['columns', 'orders', 'limit', 'offset'])
            ->cloneWithoutBindings(['select', 'order'])
            ->selectRaw(implode(', ', $selects))
            ->first();

        $totals = [];
        foreach ($sumColumns as $i => $column) {
            /** @var int|float|string|null $sum */
            $sum = $row->{'lg_sum_'.$i} ?? null;
            // Keep integer paise as int; only a genuinely fractional sum becomes float.
            $totals[$column] = $this->normaliseNumeric($sum);
        }

        return [(int) ($row->lg_total ?? 0), $totals];
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
