<?php

declare(strict_types=1);

namespace LaraGrid\Query;

/**
 * What: The storage contract for a readonly grid's LIVE query state — the search, filters,
 *       sort and per-page an operator currently has applied (never the page number).
 *
 * Why:  Persistence is a swappable adapter, exactly as it is for saved views: the shipped
 *       SessionQueryStore keeps state in the Laravel session (so it dies with the session —
 *       the deliberate lifetime of ->persistQuery('session')), and an app that wants a cache
 *       store, a per-tenant table or an existing preferences service rebinds this interface in
 *       its own provider — `$this->app->bind(QueryStore::class, MyQueryStore::class)` — with
 *       nothing else changing. The `$key` is the grid's declared persistence key (the grid name
 *       unless overridden), already namespaced by the store implementation.
 *
 * When: Read by ConfigSerializer when it builds page 1, written by WithLaraGrid::gridFetch
 *       after every successful sort / search / filter / per-page change.
 */
interface QueryStore
{
    /**
     * The stored state for a key, or an empty array when nothing is stored.
     *
     * Implementations must never throw: an unreadable or corrupt entry behaves as "nothing
     * stored", so a persistence backend can never break a grid's first paint.
     *
     * @return array<string, mixed>
     */
    public function get(string $key): array;

    /**
     * Store (replacing wholesale) the sanitized query state for a key.
     *
     * @param  array<string, mixed>  $state  Already sanitized by ViewState::sanitizeQuery().
     */
    public function put(string $key, array $state): void;

    /** Drop the stored entry — the operator is back on the grid's declared defaults. */
    public function forget(string $key): void;
}
