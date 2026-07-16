<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Illuminate\Foundation\Auth\User as Authenticatable;

/**
 * A minimal authenticatable for actingAs() in saved-views tests — never persisted; the guard
 * only needs getAuthIdentifier() (the id) to mint the per-operator view scope.
 */
class TestUser extends Authenticatable
{
    protected $guarded = [];

    public $timestamps = false;
}
