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
 *       tags at a CDN; with no asset_url a published copy under public/vendor/laragrid is
 *       preferred automatically (a static file, no Laravel boot per asset request) when it
 *       is from this release, and the internal route is the fallback that makes
 *       `composer require` alone sufficient. A copy left behind by an older release is
 *       ignored: an upgrade must never pair the old JavaScript with the new PHP.
 *
 * When: inject() runs on Laravel's RequestHandled event (registered by the service
 *       provider); the tag builders also back the Blade directives.
 */
class Assets
{
    /** The published copy's location under public/ (the laragrid-assets publish tag). */
    public const PUBLISHED_DIR = 'vendor/laragrid';

    /** Cached content-hash version (per process) — busts browser caches on package upgrade. */
    private static ?string $version = null;

    /**
     * Per-process memo of "is this file published?" so a page with two tags stats once each.
     *
     * @var array<string, bool>
     */
    private static array $published = [];

    /** Per-process memo of "does the published copy carry this release's version stamp?". */
    private static ?bool $publishedCurrent = null;

    public static function scriptTag(): string
    {
        return '<script src="'.self::url('laragrid.min.js').'" defer></script>';
    }

    public static function styleTag(): string
    {
        return '<link rel="stylesheet" href="'.self::url('laragrid.min.css').'">';
    }

    /**
     * The URL for one dist file — in order of preference: the configured asset_url base
     * (CDN / any published copy), the auto-detected published copy under public/vendor/laragrid,
     * else the internal serving route — all with the ?v= content hash.
     */
    public static function url(string $file): string
    {
        $base = config('laragrid.asset_url');

        if (is_string($base) && $base !== '') {
            $path = rtrim($base, '/').'/'.$file;
        } elseif (self::isPublished($file)) {
            $path = asset(self::PUBLISHED_DIR.'/'.$file);
        } else {
            $path = route('laragrid.asset', ['file' => $file], false);
        }

        return $path.'?v='.self::version();
    }

    /**
     * A short content hash of the bundled JS — one version stamps both tags (the CSS ships
     * in the same release, so a JS change is the upgrade signal). Read from dist/version.txt
     * (written by the build) so no request hashes the 160 KB bundle; md5_file is the fallback
     * for a dist without the stamp, and it yields the same digest.
     */
    public static function version(): string
    {
        if (self::$version !== null) {
            return self::$version;
        }

        $stamp = self::distPath('version.txt');
        $stamped = is_file($stamp) ? trim((string) file_get_contents($stamp)) : '';
        if (preg_match('/^[0-9a-f]{12}$/', $stamped) === 1) {
            return self::$version = $stamped;
        }

        $path = self::distPath('laragrid.min.js');
        $hash = is_file($path) ? md5_file($path) : false;

        return self::$version = $hash === false ? 'dev' : substr($hash, 0, 12);
    }

    /** Absolute path of a file in the package's dist/ directory. */
    public static function distPath(string $file): string
    {
        return dirname(__DIR__, 2).'/dist/'.$file;
    }

    /**
     * Whether `vendor:publish --tag=laragrid-assets` placed this file under public/ and that
     * copy is from this release. The publish copies dist/ whole, so a current copy carries a
     * version.txt equal to the package's own; a copy with no stamp (releases before 1.45) or
     * another build's stamp is stale and the route serves the current bundle instead.
     */
    protected static function isPublished(string $file): bool
    {
        return self::$published[$file] ??= self::publishedIsCurrent()
            && is_file(public_path(self::PUBLISHED_DIR.'/'.$file));
    }

    /** Whether public/vendor/laragrid/version.txt matches this package's dist/version.txt. */
    private static function publishedIsCurrent(): bool
    {
        if (self::$publishedCurrent !== null) {
            return self::$publishedCurrent;
        }

        $stamp = public_path(self::PUBLISHED_DIR.'/version.txt');
        $published = is_file($stamp) ? trim((string) file_get_contents($stamp)) : '';

        return self::$publishedCurrent = $published !== '' && $published === self::version();
    }

    /** Test seam: forget the per-process memos (published copies, version). */
    public static function flush(): void
    {
        self::$version = null;
        self::$published = [];
        self::$publishedCurrent = null;
    }

    /**
     * Whether this response should receive the tags: an HTML page that rendered at least
     * one grid mount and doesn't already reference the bundle. The Content-Type check comes
     * first so JSON (Livewire updates), downloads and assets are never scanned at all.
     */
    public static function shouldInject(Response $response): bool
    {
        if (! config('laragrid.inject_assets', true)) {
            return false;
        }

        $type = (string) $response->headers->get('Content-Type', '');
        if (! str_starts_with(strtolower($type), 'text/html')) {
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
