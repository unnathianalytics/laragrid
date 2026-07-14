<?php

declare(strict_types=1);

namespace LaraGrid\Http;

use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use Symfony\Component\HttpFoundation\Response;

/**
 * What: Serves the package's prebuilt dist/ assets over an internal route
 *       (GET /laragrid/{file}) — the Livewire delivery model.
 *
 * Why:  `composer require` must be the whole install: no npm, no publish step, no manual
 *       copying. Serving straight from the vendor directory (whitelisted, never
 *       path-derived) with immutable cache headers + an ETag keeps it both safe and as
 *       cheap as a static file after the first hit; the ?v= content hash on the generated
 *       tags busts caches across package upgrades.
 *
 * When: Route registered by routes/laragrid.php; URLs built by Support\Assets.
 */
class AssetController
{
    /**
     * The servable files — an explicit whitelist, so no request input ever reaches the
     * filesystem as a path.
     *
     * @var array<string, string>
     */
    private const FILES = [
        'laragrid.min.js' => 'application/javascript; charset=utf-8',
        'laragrid.min.js.map' => 'application/json',
        'laragrid.esm.js' => 'application/javascript; charset=utf-8',
        'laragrid.esm.js.map' => 'application/json',
        'laragrid.min.css' => 'text/css; charset=utf-8',
    ];

    public function __invoke(Request $request, string $file): Response
    {
        if (! isset(self::FILES[$file])) {
            abort(404);
        }

        $path = dirname(__DIR__, 2).'/dist/'.$file;
        if (! is_file($path)) {
            abort(404);
        }

        $response = new BinaryFileResponse($path, 200, [
            'Content-Type' => self::FILES[$file],
            'Cache-Control' => 'public, max-age=31536000, immutable',
        ]);
        $response->setEtag(md5_file($path) ?: null);
        $response->isNotModified($request);

        return $response;
    }
}
