<?php

declare(strict_types=1);

namespace LaraGrid\Http;

use Illuminate\Http\Request;
use LaraGrid\Support\Assets;
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
 *       tags busts caches across package upgrades. The build ships .br/.gz siblings, so a
 *       browser that accepts them gets the precompressed file (Content-Encoding + Vary)
 *       even when the web server never compresses dynamic responses.
 *
 * When: Route registered by routes/laragrid.php; URLs built by Support\Assets.
 */
class AssetController
{
    /**
     * The servable files — an explicit whitelist, so no request input ever reaches the
     * filesystem as a path. The .br/.gz siblings derive from these names only.
     *
     * @var array<string, string>
     */
    private const FILES = [
        'laragrid.min.js' => 'application/javascript; charset=utf-8',
        'laragrid.min.js.map' => 'application/json',
        'laragrid.min.css' => 'text/css; charset=utf-8',
    ];

    /**
     * Encodings negotiated from Accept-Encoding, in preference order, with their file suffix.
     *
     * @var array<string, string>
     */
    private const ENCODINGS = ['br' => '.br', 'gzip' => '.gz'];

    public function __invoke(Request $request, string $file): Response
    {
        if (! isset(self::FILES[$file])) {
            abort(404);
        }

        $path = Assets::distPath($file);
        if (! is_file($path)) {
            abort(404);
        }

        $encoding = $this->negotiate($request, $path);

        $response = new BinaryFileResponse($encoding === null ? $path : $path.self::ENCODINGS[$encoding], 200, [
            'Content-Type' => self::FILES[$file],
            'Cache-Control' => 'public, max-age=31536000, immutable',
        ]);
        // One ETag per representation (the compressed body is a different entity).
        $response->setEtag(Assets::version().($encoding === null ? '' : '-'.$encoding));
        $response->setVary('Accept-Encoding');
        if ($encoding !== null) {
            $response->headers->set('Content-Encoding', $encoding);
        }
        $response->isNotModified($request);

        return $response;
    }

    /** The first accepted encoding whose precompressed sibling exists, else null (identity). */
    private function negotiate(Request $request, string $path): ?string
    {
        $accept = strtolower((string) $request->headers->get('Accept-Encoding', ''));
        if ($accept === '') {
            return null;
        }

        $accepted = array_map('trim', explode(',', $accept));
        foreach (self::ENCODINGS as $encoding => $suffix) {
            foreach ($accepted as $token) {
                // "br", "br;q=1.0" — a q=0 opts out.
                [$name, $q] = array_pad(explode(';', $token, 2), 2, null);
                if (trim($name) === $encoding && ! str_contains((string) $q, 'q=0') && is_file($path.$suffix)) {
                    return $encoding;
                }
            }
        }

        return null;
    }
}
