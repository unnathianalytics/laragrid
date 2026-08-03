<?php

declare(strict_types=1);

use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Schema;
use LaraGrid\Tests\Hosts\DisplayGridComponent;
use LaraGrid\Tests\Hosts\ServerGridComponent;
use LaraGrid\Tests\Hosts\TestUser;
use Livewire\Livewire;

/**
 * What: Pins the fixes for GitHub issues #4 (string authorize() 403s in Livewire 4
 *       anonymous components — authorizeGrid now goes through Gate::authorize, never the
 *       host's AuthorizesRequests trait) and #5 (refreshGrid(): the host-facing re-fetch
 *       seam for server-side grids).
 */
beforeEach(function () {
    Schema::create('export_items', function (Blueprint $table) {
        $table->id();
        $table->string('name');
        $table->string('code')->nullable();
        $table->string('type');
        $table->integer('qty');
        $table->string('rate');
        $table->boolean('active');
        $table->date('booked_on')->nullable();
        $table->string('note')->nullable();
        $table->string('secret')->nullable();
        $table->timestamps();
    });
});

it('authorizes a STRING ability through the Gate, independent of the host (issue #4)', function () {
    Gate::define('laragrid.items.view', fn (?TestUser $user = null): bool => true);

    Livewire::test(ServerGridComponent::class, ['gateAbility' => 'laragrid.items.view'])
        ->call('gridFetch', 'items', [])
        ->assertOk();
});

it('still denies fail-closed when the Gate refuses the string ability', function () {
    Gate::define('laragrid.items.view', fn (?TestUser $user = null): bool => false);

    Livewire::test(ServerGridComponent::class, ['gateAbility' => 'laragrid.items.view'])
        ->call('gridFetch', 'items', [])
        ->assertStatus(403);
});

it('refreshGrid() dispatches the lgrid:refresh window event for the client (issue #5)', function () {
    Livewire::test(ServerGridComponent::class)
        ->call('refreshItems')
        ->assertDispatched('lgrid:refresh', grid: 'items');
});

it('refreshGrid() refuses a non-server grid — reseedGrid() owns in-memory rows', function () {
    $method = new ReflectionMethod(DisplayGridComponent::class, 'refreshGrid');

    expect(fn () => $method->invoke(new DisplayGridComponent, 'taxes'))
        ->toThrow(InvalidArgumentException::class, 'not server-side');
});
