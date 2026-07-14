<?php

declare(strict_types=1);

namespace LaraGrid\Tests;

use LaraGrid\LaraGridServiceProvider;
use Livewire\LivewireServiceProvider;
use Orchestra\Testbench\TestCase as Orchestra;

/**
 * What: The package test base — boots a Testbench app with Livewire + LaraGrid registered.
 *
 * Why:  Grid tests need a real container (validation, views, Livewire component lifecycle)
 *       without a host application; Testbench is the package-side stand-in for larafin's
 *       feature-test harness so the ported suites keep their shape.
 *
 * When: Extended by every Pest test via tests/Pest.php `uses()`.
 */
abstract class TestCase extends Orchestra
{
    /**
     * @return list<class-string>
     */
    protected function getPackageProviders($app): array
    {
        return [
            LivewireServiceProvider::class,
            LaraGridServiceProvider::class,
        ];
    }

    protected function defineEnvironment($app): void
    {
        // Test-only fixture views (Livewire hosts used to exercise the trait + mount).
        $app['view']->addNamespace('laragrid-tests', __DIR__.'/Hosts/views');
    }
}
