<?php

declare(strict_types=1);

namespace LaraGrid;

use Illuminate\Foundation\Http\Events\RequestHandled;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\ServiceProvider;
use LaraGrid\Casting\CastRegistry;
use LaraGrid\Export\ExporterRegistry;
use LaraGrid\Formatting\FormatRegistry;
use LaraGrid\Support\Assets;

/**
 * What: The package entry point — merges config, loads views, registers the publishing
 *       groups and (P4) the asset-delivery seams.
 *
 * Why:  One provider is the whole install surface: `composer require unnathianalytics/laragrid`
 *       must be sufficient for `<x-laragrid :grid>` to work with zero npm and zero blade
 *       wiring (plan: Goal). Registries (formats/casts) bind here as singletons so a host
 *       app extends LaraGrid from its own provider exactly the way larafin registered its
 *       INR formatters (source plan §3.11 — the portability seam).
 *
 * When: Auto-discovered via composer extra.laravel.providers.
 */
class LaraGridServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/laragrid.php', 'laragrid');

        // The extension registries, shared per request so app-side registrations
        // (custom formatters / parse-kind casts / export formats, e.g. an accounting app's
        // 'paise' cast or a dompdf-backed 'pdf') are visible to every serializer and applier.
        // Core defaults self-register in the constructors: text/number/date formats;
        // text/int/decimal/select/bool/date casts; csv/xlsx/pdf exporters.
        $this->app->singleton(FormatRegistry::class);
        $this->app->singleton(CastRegistry::class);
        $this->app->singleton(ExporterRegistry::class);
    }

    public function boot(): void
    {
        $this->loadViewsFrom(__DIR__.'/../resources/views', 'laragrid');
        $this->loadRoutesFrom(__DIR__.'/../routes/laragrid.php');

        $this->publishes([
            __DIR__.'/../config/laragrid.php' => config_path('laragrid.php'),
        ], 'laragrid-config');

        $this->publishes([
            __DIR__.'/../resources/views' => resource_path('views/vendor/laragrid'),
        ], 'laragrid-views');

        $this->publishes([
            __DIR__.'/../dist' => public_path('vendor/laragrid'),
        ], 'laragrid-assets');

        Blade::component('laragrid', View\DatagridComponent::class);

        // Asset delivery (P4) — the manual directives, and the zero-config auto-injection:
        // any HTML response that rendered a grid mount (`data-lgrid`) and doesn't already
        // reference the bundle gets the style+deferred-script tags injected. Stateless
        // trigger (the response content itself), so Octane needs no per-request flag reset.
        Blade::directive('laragridScripts', fn (): string => "<?php echo \LaraGrid\Support\Assets::scriptTag(); ?>");
        Blade::directive('laragridStyles', fn (): string => "<?php echo \LaraGrid\Support\Assets::styleTag(); ?>");

        Event::listen(RequestHandled::class, function (RequestHandled $event): void {
            if (Assets::shouldInject($event->response)) {
                Assets::inject($event->response);
            }
        });
    }
}
