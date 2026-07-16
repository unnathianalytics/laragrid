<?php

declare(strict_types=1);

namespace LaraGrid\Views;

use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * What: The shipped ViewStore — saved views in a plain DB table (config `laragrid.views.table`,
 *       default `laragrid_views`), one row per (scope, grid_key, name) with the sanitized state
 *       as JSON text.
 *
 * Why:  A query-builder store (no model) keeps the package dependency-free and the schema
 *       trivial: the unique (scope, grid_key, name) index makes "save again under the same
 *       name" an overwrite, which is the operator mental model ("update my view"). State is
 *       decoded defensively — a hand-edited or truncated row yields an empty state, never a
 *       crash. The migration auto-loads with the package, so `composer require` + `migrate`
 *       is the whole install.
 *
 * When: Bound to ViewStore in LaraGridServiceProvider; apps rebind for custom storage.
 */
class DatabaseViewStore implements ViewStore
{
    /**
     * @return list<array{id: string, name: string, state: array<string, mixed>}>
     */
    public function list(string $scope, string $gridKey): array
    {
        return $this->table()
            ->where('scope', $scope)
            ->where('grid_key', $gridKey)
            ->orderBy('name')
            ->get()
            ->map(fn (object $row): array => $this->present($row))
            ->all();
    }

    /**
     * @param  array<string, mixed>  $state
     * @return array{id: string, name: string, state: array<string, mixed>}
     */
    public function save(string $scope, string $gridKey, string $name, array $state): array
    {
        $keys = ['scope' => $scope, 'grid_key' => $gridKey, 'name' => $name];
        $json = (string) json_encode($state);

        $existing = $this->table()->where($keys)->first();

        if ($existing !== null) {
            $this->table()->where('id', $existing->id)->update(['state' => $json, 'updated_at' => now()]);
            $id = (int) $existing->id;
        } else {
            $id = (int) $this->table()->insertGetId([
                ...$keys,
                'state' => $json,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        return ['id' => (string) $id, 'name' => $name, 'state' => $state];
    }

    public function delete(string $scope, string $gridKey, string $id): void
    {
        $this->table()
            ->where('scope', $scope)
            ->where('grid_key', $gridKey)
            ->where('id', $id)
            ->delete();
    }

    protected function table(): Builder
    {
        /** @var string $table */
        $table = config('laragrid.views.table', 'laragrid_views');

        return DB::table($table);
    }

    /**
     * @return array{id: string, name: string, state: array<string, mixed>}
     */
    protected function present(object $row): array
    {
        $state = json_decode((string) $row->state, true);

        return [
            'id' => (string) $row->id,
            'name' => (string) $row->name,
            'state' => is_array($state) ? $state : [],
        ];
    }
}
