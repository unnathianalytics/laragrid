<?php

declare(strict_types=1);

namespace LaraGrid\Support;

use Symfony\Component\HttpFoundation\Response;

/**
 * What: Builds the LaraGrid asset tags (script/style, content-hash versioned) and performs
 *       the response auto-injection — the zero-blade-config delivery path.
 *
 * Why:  A page that renders a grid must receive dist/laragrid.min.{js,css} without the
 *       developer registering anything in a layout. The injection trigger is the rendered
 *       HTML itself (`data-lgrid` in the response — stateless, so Octane/queue workers need
 *       no per-request flag hygiene), it skips responses that already carry the assets
 *       (manual @laragridScripts/@laragridStyles present), and it can be disabled wholesale
 *       via config('laragrid.inject_assets'). config('laragrid.asset_url') redirects the
 *       tags at a CDN/published copy instead of the internal route.
 *
 * When: inject() runs on Laravel's RequestHandled event (registered by the service
 *       provider); the tag builders also back the Blade directives.
 */
class Assets
{
    /** Cached content-hash version (per process) — busts browser caches on package upgrade. */
    private static ?string $version = null;

    public static function scriptTag(): string
    {
        return '<script src="'.self::url('laragrid.min.js').'" defer></script>';
    }

    public static function styleTag(): string
    {
        return '<link rel="stylesheet" href="'.self::url('laragrid.min.css').'">';
    }

    /**
     * The URL for one dist file: the configured asset_url base when set (CDN / published
     * copy), else the internal serving route — both with the ?v= content hash.
     */
    public static function url(string $file): string
    {
        $base = config('laragrid.asset_url');
        $path = is_string($base) && $base !== ''
            ? rtrim($base, '/').'/'.$file
            : route('laragrid.asset', ['file' => $file], false);

        return $path.'?v='.self::version();
    }

    /**
     * A short content hash of the bundled JS — one version stamps both tags (the CSS ships
     * in the same release, so a JS change is the upgrade signal).
     */
    public static function version(): string
    {
        if (self::$version !== null) {
            return self::$version;
        }

        $path = dirname(__DIR__, 2).'/dist/laragrid.min.js';
        $hash = is_file($path) ? md5_file($path) : false;

        return self::$version = $hash === false ? 'dev' : substr($hash, 0, 12);
    }

    /**
     * Whether this response should receive the tags: an HTML page that rendered at least
     * one grid mount and doesn't already reference the bundle.
     */
    public static function shouldInject(Response $response): bool
    {
        if (! config('laragrid.inject_assets', true)) {
            return false;
        }

        $content = $response->getContent();

        return is_string($content)
            && str_contains($content, 'data-lgrid')
            && str_contains($content, '</html>')
            && ! str_contains($content, 'laragrid.min.js');
    }

    /**
     * Inject the style into <head> and the deferred script alongside it (order-independent:
     * the boot module resolves Livewire lazily, so placement never races Livewire's own
     * script). Falls back to before </body> for head-less documents.
     */
    public static function inject(Response $response): void
    {
        $content = $response->getContent();
        if (! is_string($content)) {
            return;
        }

        $tags = self::styleTag().self::scriptTag();

        $injected = preg_replace('/<\/head>/i', $tags.'</head>', $content, 1, $count);
        if ($count === 0) {
            $injected = preg_replace('/<\/body>/i', $tags.'</body>', $content, 1, $count);
        }

        if ($count > 0 && is_string($injected)) {
            $response->setContent($injected);
            // The length changed; a stale Content-Length would truncate the page.
            $response->headers->remove('Content-Length');
        }
    }
}
