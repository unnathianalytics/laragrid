<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * What: The parent of RelatedItem — a tiny `item_groups` table so a grid can declare a
 *       dot-path column ('group.name') over a real BelongsTo relation, plus a self-referencing
 *       `parent` relation and a JSON `meta` attribute for the nested-path cases
 *       ('group.parent.name' is two relations deep, 'group.meta.color' is one).
 *
 * When: tests/Feature/RelationLoadingTest creates the table + rows per test.
 */
class ItemGroup extends Model
{
    protected $guarded = [];

    protected $casts = [
        'meta' => 'array',
    ];

    public function parent(): BelongsTo
    {
        return $this->belongsTo(self::class, 'parent_id');
    }
}
