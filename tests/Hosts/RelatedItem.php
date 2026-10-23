<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Database\Eloquent\Relations\BelongsTo;
use RuntimeException;

/**
 * What: ExportItem over the same `export_items` table, plus a BelongsTo relation (group), a
 *       JSON attribute (meta), and a relation that refuses eager loading (fragileGroup).
 *
 * Why:  The relation auto eager-load must add `group` for a 'group.name' column but leave a
 *       'meta.color' JSON path alone, and must fall back to per-row loading when an eager load
 *       throws. One model carrying all three keeps the contrast in a single fixture without
 *       touching the ExportItem every other suite shares.
 *
 * When: tests/Feature/RelationLoadingTest.
 */
class RelatedItem extends ExportItem
{
    protected $table = 'export_items';

    protected $casts = [
        'rate' => 'decimal:2',
        'active' => 'boolean',
        'meta' => 'array',
    ];

    public function group(): BelongsTo
    {
        return $this->belongsTo(ItemGroup::class, 'group_id');
    }

    /**
     * The same BelongsTo as group(), except that eager loading throws. Lazy loading (one query
     * per row) still works, so it probes the grid's eager-load fallback.
     */
    public function fragileGroup(): BelongsTo
    {
        $related = $this->newRelatedInstance(ItemGroup::class);

        return new class($related->newQuery(), $this, 'group_id', 'id', 'fragileGroup') extends BelongsTo
        {
            public function addEagerConstraints(array $models): void
            {
                throw new RuntimeException('fragileGroup cannot be eager-loaded.');
            }
        };
    }
}
