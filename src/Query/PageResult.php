<?php

declare(strict_types=1);

namespace LaraGrid\Query;

/**
 * What: The immutable value object a QueryPipeline run returns — one page of already-serialized
 *       client rows plus the metadata the client's pagination chrome and footer need: total
 *       (filtered), current page/perPage, and the per-page and grand (whole-filtered-set) totals.
 *
 * Why:  gridFetch returns exactly this shape (via ->toArray()); modelling it as a typed object
 *       keeps the pipeline's output contract explicit and the trait/serializer honest. Grand
 *       totals are computed over the *filtered* query (the register total accountants read), and
 *       page totals over the returned rows — both shipped, both labelled, so a paginated footer
 *       never lies about being partial (plan §2.5.4, M3 decision record).
 *
 * When: Built by QueryPipeline::run(); ->toArray() is the gridFetch payload and the first-page
 *       config fragment.
 */
final class PageResult
{
    /**
     * @param  list<array<string, mixed>>  $rows  Already client-serialized rows (RowSerializer output).
     * @param  int  $total  Total rows in the filtered set (before pagination).
     * @param  int  $page  1-based current page.
     * @param  int  $perPage  Rows per page.
     * @param  array<string, int|float>  $pageTotals  Aggregate value per column over this page's rows.
     * @param  array<string, int|float>  $grandTotals  Aggregate value per column over the whole filtered set.
     */
    public function __construct(
        public readonly array $rows,
        public readonly int $total,
        public readonly int $page,
        public readonly int $perPage,
        public readonly array $pageTotals = [],
        public readonly array $grandTotals = [],
    ) {}

    /**
     * The last page number for the current perPage (at least 1).
     */
    public function lastPage(): int
    {
        return max(1, (int) ceil($this->total / max(1, $this->perPage)));
    }

    /**
     * @return array{
     *     rows: list<array<string, mixed>>,
     *     total: int,
     *     page: int,
     *     perPage: int,
     *     lastPage: int,
     *     pageTotals: array<string, int|float>,
     *     grandTotals: array<string, int|float>,
     * }
     */
    public function toArray(): array
    {
        return [
            'rows' => $this->rows,
            'total' => $this->total,
            'page' => $this->page,
            'perPage' => $this->perPage,
            'lastPage' => $this->lastPage(),
            'pageTotals' => $this->pageTotals,
            'grandTotals' => $this->grandTotals,
        ];
    }
}
