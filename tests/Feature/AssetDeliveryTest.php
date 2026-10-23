<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Route;
use LaraGrid\Support\Assets;

beforeEach(function () {
    Assets::flush();
});

afterEach(function () {
    File::deleteDirectory(public_path(Assets::PUBLISHED_DIR));
    Assets::flush();
});

it('serves the bundled js over the internal route with immutable caching', function () {
    $response = $this->get('/laragrid/laragrid.min.js');

    $response->assertOk();
    expect($response->headers->get('Content-Type'))->toContain('javascript');
    expect($response->headers->get('Cache-Control'))->toContain('immutable');
    expect($response->headers->get('ETag'))->not->toBeNull();
    expect($response->headers->get('Content-Encoding'))->toBeNull();
    expect($response->headers->get('Vary'))->toBe('Accept-Encoding');
});

it('serves the bundled css over the internal route', function () {
    $this->get('/laragrid/laragrid.min.css')
        ->assertOk()
        ->assertHeader('Content-Type', 'text/css; charset=utf-8');
});

it('rejects files outside the whitelist', function () {
    $this->get('/laragrid/..%2fcomposer.json')->assertNotFound();
    $this->get('/laragrid/evil.php')->assertNotFound();
    // The ESM bundle is no longer built or served; Vite consumers import resources/js/index.js.
    $this->get('/laragrid/laragrid.esm.js')->assertNotFound();
    $this->get('/laragrid/laragrid.min.js.br')->assertNotFound();
});

it('serves the precompressed brotli body to a client that accepts it', function () {
    $response = $this->get('/laragrid/laragrid.min.js', ['Accept-Encoding' => 'gzip, deflate, br']);

    $response->assertOk();
    expect($response->headers->get('Content-Encoding'))->toBe('br');
    expect($response->headers->get('Content-Type'))->toContain('javascript');
    expect($response->headers->get('Vary'))->toBe('Accept-Encoding');
    expect($response->headers->get('ETag'))->toContain('-br');
    expect($response->baseResponse->getFile()->getPathname())->toEndWith('laragrid.min.js.br');
});

it('falls back to gzip, then to the plain file', function () {
    $gzip = $this->get('/laragrid/laragrid.min.css', ['Accept-Encoding' => 'gzip']);
    expect($gzip->headers->get('Content-Encoding'))->toBe('gzip');
    expect($gzip->baseResponse->getFile()->getPathname())->toEndWith('laragrid.min.css.gz');

    $plain = $this->get('/laragrid/laragrid.min.css', ['Accept-Encoding' => 'identity']);
    expect($plain->headers->get('Content-Encoding'))->toBeNull();
    expect($plain->baseResponse->getFile()->getPathname())->toEndWith('laragrid.min.css');

    $optedOut = $this->get('/laragrid/laragrid.min.css', ['Accept-Encoding' => 'br;q=0, gzip']);
    expect($optedOut->headers->get('Content-Encoding'))->toBe('gzip');
});

it('stamps the tags with the build-time version file and answers 304 on a matching ETag', function () {
    $stamp = trim((string) file_get_contents(Assets::distPath('version.txt')));

    expect(Assets::version())->toBe($stamp)
        ->and(Assets::scriptTag())->toContain('?v='.$stamp);

    $first = $this->get('/laragrid/laragrid.min.js');
    $etag = (string) $first->headers->get('ETag');

    $this->get('/laragrid/laragrid.min.js', ['If-None-Match' => $etag])->assertStatus(304);
    // The compressed representation has its own ETag; a stale plain one must not match it.
    $this->get('/laragrid/laragrid.min.js', ['If-None-Match' => $etag, 'Accept-Encoding' => 'br'])->assertOk();
});

it('builds versioned tags and honours a configured asset_url base', function () {
    expect(Assets::scriptTag())
        ->toContain('/laragrid/laragrid.min.js?v='.Assets::version())
        ->toContain('defer');
    expect(Assets::styleTag())->toContain('/laragrid/laragrid.min.css?v=');

    config()->set('laragrid.asset_url', 'https://cdn.example.com/laragrid');
    expect(Assets::url('laragrid.min.js'))
        ->toStartWith('https://cdn.example.com/laragrid/laragrid.min.js?v=');
});

it('prefers a published copy under public/vendor/laragrid over the internal route', function () {
    expect(Assets::url('laragrid.min.js'))->toStartWith('/laragrid/laragrid.min.js');

    File::ensureDirectoryExists(public_path(Assets::PUBLISHED_DIR));
    File::put(public_path(Assets::PUBLISHED_DIR.'/laragrid.min.js'), '// published');
    Assets::flush();

    expect(Assets::url('laragrid.min.js'))
        ->toContain('/vendor/laragrid/laragrid.min.js?v='.Assets::version())
        ->not->toStartWith('/laragrid/');
    // Only the files actually published switch; the stylesheet still rides the route.
    expect(Assets::url('laragrid.min.css'))->toStartWith('/laragrid/laragrid.min.css');

    // An explicit asset_url still wins over the auto-detected copy.
    config()->set('laragrid.asset_url', 'https://cdn.example.com/laragrid');
    expect(Assets::url('laragrid.min.js'))->toStartWith('https://cdn.example.com/laragrid/');
});

it('renders the blade directives as real tags', function () {
    expect(Blade::render('@laragridStyles @laragridScripts'))
        ->toContain('<link rel="stylesheet"')
        ->toContain('<script src=');
});

it('auto-injects assets into an html page that rendered a grid mount', function () {
    Route::get('/with-grid', fn () => '<html><head><title>t</title></head><body><div data-lgrid></div></body></html>');

    $html = $this->get('/with-grid')->assertOk()->getContent();

    expect($html)
        ->toContain('laragrid.min.css')
        ->toContain('laragrid.min.js')
        // Injected into <head>, ahead of the closing tag.
        ->toMatch('/<link rel="stylesheet"[^>]+laragrid\.min\.css[^>]*>\s*<script[^>]+laragrid\.min\.js[^>]*><\/script><\/head>/');
});

it('leaves pages without a grid mount untouched', function () {
    Route::get('/plain', fn () => '<html><head></head><body>hello</body></html>');

    expect($this->get('/plain')->getContent())->not->toContain('laragrid.min.js');
});

it('never scans or injects a non-html response', function () {
    // A JSON body that happens to carry the markers (a Livewire update payload does) is left alone.
    Route::get('/json', fn () => response()->json(['html' => '<html><div data-lgrid></div></html>']));

    $response = $this->get('/json')->assertOk();

    expect($response->getContent())->not->toContain('laragrid.min.js');
    expect(Assets::shouldInject($response->baseResponse))->toBeFalse();
});

it('does not double-inject when the directives are already present', function () {
    Route::get('/manual', fn () => '<html><head>'.Assets::styleTag().Assets::scriptTag().'</head>'
        .'<body><div data-lgrid></div></body></html>');

    $html = $this->get('/manual')->getContent();

    expect(substr_count((string) $html, 'laragrid.min.js'))->toBe(1);
});

it('respects the inject_assets kill switch', function () {
    config()->set('laragrid.inject_assets', false);
    Route::get('/with-grid-off', fn () => '<html><head></head><body><div data-lgrid></div></body></html>');

    expect($this->get('/with-grid-off')->getContent())->not->toContain('laragrid.min.js');
});
