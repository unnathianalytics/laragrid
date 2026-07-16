<?php

declare(strict_types=1);

namespace LaraGrid\Views;

/**
 * What: The storage contract for saved grid views — named, per-operator snapshots of a
 *       readonly grid's state (search, filters, sort, per-page, column widths + hidden set).
 *
 * Why:  Persistence is a swappable adapter: the shipped DatabaseViewStore keeps views in the
 *       `laragrid_views` table (auto-migrated), and an app that wants Redis, a tenant table or
 *       an existing preferences service rebinds this interface in its own provider —
 *       `$this->app->bind(ViewStore::class, MyViewStore::class)` — with nothing else changing.
 *       The `$scope` is an opaque operator identity token minted by WithLaraGrid ('u:{id}');
 *       stores must isolate rows by (scope, gridKey) so one operator can never list, load or
 *       delete another's views (fail-closed, G12).
 *
 * When: Resolved by the gridViews/gridViewSave/gridViewDelete RPCs in WithLaraGrid.
 */
interface ViewStore
{
    /**
     * All views saved under (scope, gridKey), name-ordered.
     *
     * @return list<array{id: string, name: string, state: array<string, mixed>}>
     */
    public function list(string $scope, string $gridKey): array;

    /**
     * Create — or overwrite by (scope, gridKey, name) — one view. Returns the saved view.
     *
     * @param  array<string, mixed>  $state  Already sanitized by ViewState.
     * @return array{id: string, name: string, state: array<string, mixed>}
     */
    public function save(string $scope, string $gridKey, string $name, array $state): array;

    /** Delete one view by id — scoped, so a foreign id is a silent no-op. */
    public function delete(string $scope, string $gridKey, string $id): void;
}
