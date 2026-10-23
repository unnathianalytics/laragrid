<?php

declare(strict_types=1);

namespace LaraGrid\Query;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Database\Eloquent\Relations\Relation;
use LaraGrid\Grid;
use Throwable;

/**
 * What: Eager-loads the relations a grid's dot-keyed columns read ('group.name' needs `group`),
 *       adding only what the host query does not already load.
 *
 * Why:  RowSerializer and ExportBuilder resolve a dot key with data_get() against the model,
 *       which lazy-loads the relation once per row unless the host called with(): a page of 20
 *       rows becomes 22 queries. A path is loaded only while its segments really are relations
 *       (a JSON attribute path such as 'meta.color' stays with data_get), and an entry the host
 *       declared — possibly with a constraint or a column list — is never replaced.
 *
 * When: QueryPipeline::run() before the page SELECT, ExportBuilder::queryRows() before the
 *       stream. Both call fallBack() if the added eager loads make the fetch throw.
 */
final class AppliesEagerLoads
{
    /**
     * Add the missing eager loads to the query.
     *
     * What: For each Grid::relationPaths() entry, keeps the leading run of segments that are
     *       relations (see loadablePath()). A path counts as already loaded when an eager key
     *       equals it or starts with it plus a dot. Missing entries are added prefix by prefix,
     *       the way with() expands 'a.b' into 'a' and 'a.b', but an existing key is left as is.
     * Why:  with('group.parent') would overwrite a host's constrained 'group' entry with an
     *       empty one, so the eager-load map is merged here instead.
     *
     * @param  Builder<covariant Model>  $query
     * @return list<string> The eager-load keys this call added (empty when nothing was missing).
     */
    public function apply(Builder $query, Grid $grid): array
    {
        $paths = $grid->relationPaths();
        if ($paths === []) {
            return [];
        }

        $model = $query->getModel();
        $eager = $query->getEagerLoads();
        $added = [];

        foreach ($paths as $path) {
            $path = $this->loadablePath($model, $path);
            if ($path === null || $this->isLoaded($eager, $path)) {
                continue;
            }

            $prefix = '';
            foreach (explode('.', $path) as $segment) {
                $prefix = $prefix === '' ? $segment : $prefix.'.'.$segment;
                if (! array_key_exists($prefix, $eager)) {
                    $eager[$prefix] = static function (): void {};
                    $added[] = $prefix;
                }
            }
        }

        if ($added !== []) {
            $query->setEagerLoads($eager);
        }

        return $added;
    }

    /**
     * Undo apply() after the fetch threw, so the caller can retry on the lazy path.
     *
     * What: Removes exactly the keys apply() added and, in the local environment, logs once per
     *       grid which paths could not be eager-loaded.
     * Why:  A relation shape the eager loader cannot handle must cost an N+1, not the page.
     *
     * @param  Builder<covariant Model>  $query
     * @param  list<string>  $added  The return value of apply().
     */
    public function fallBack(Builder $query, Grid $grid, array $added, Throwable $error): void
    {
        $query->without($added);

        static $logged = [];
        if (! isset($logged[$grid->name]) && app()->environment('local')) {
            $logged[$grid->name] = true;
            logger()->warning(
                "Grid [{$grid->name}] could not eager-load [".implode(', ', $added).'], so it loads them per row: '
                .$error->getMessage()
            );
        }
    }

    /**
     * The leading part of a relation path whose segments are relations, or null when the first
     * segment is not one.
     *
     * Why: 'group.meta' (a JSON attribute on the related model) must load `group` only. Each
     *      segment is resolved the way Eloquent's own eager loader resolves it: a name the base
     *      Model class defines is never a relation (getAttribute() treats it the same way),
     *      isRelation() must accept it, and the method must return a Relation. A MorphTo ends
     *      the walk, because its related model differs per row.
     */
    private function loadablePath(Model $model, string $path): ?string
    {
        $loadable = [];

        foreach (explode('.', $path) as $segment) {
            if ($segment === '' || method_exists(Model::class, $segment) || ! $model->isRelation($segment)) {
                break;
            }

            try {
                $relation = Relation::noConstraints(fn (): mixed => $model->newInstance()->{$segment}());
            } catch (Throwable) {
                break;
            }

            if (! $relation instanceof Relation) {
                break;
            }

            $loadable[] = $segment;

            if ($relation instanceof MorphTo) {
                break;
            }
            $model = $relation->getRelated();
        }

        return $loadable === [] ? null : implode('.', $loadable);
    }

    /**
     * @param  array<string, mixed>  $eager
     */
    private function isLoaded(array $eager, string $path): bool
    {
        if (array_key_exists($path, $eager)) {
            return true;
        }

        foreach (array_keys($eager) as $key) {
            if (str_starts_with((string) $key, $path.'.')) {
                return true;
            }
        }

        return false;
    }
}
