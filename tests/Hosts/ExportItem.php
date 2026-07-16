<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Database\Eloquent\Model;

/**
 * What: The Eloquent fixture behind the server-side (->query()) test grid — a small
 *       item register with one column per export value family (text, leading-zero code,
 *       int, fixed-scale decimal, select id, bool, date).
 *
 * Why:  Export tests must prove the pipeline over a REAL query (sort/search/filter narrowing,
 *       lazy() chunking, decimal string casts) — an array host can't exercise any of that.
 *
 * When: tests/Feature/ExportTest creates the table + rows per test.
 */
class ExportItem extends Model
{
    protected $guarded = [];

    protected $casts = [
        'rate' => 'decimal:2',
        'active' => 'boolean',
    ];
}
