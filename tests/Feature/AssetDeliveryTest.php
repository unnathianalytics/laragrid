<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\Route;
use LaraGrid\Support\Assets;

it('serves the bundled js over the internal route with immutable caching', function () {
    $response = $this->get('/laragrid/laragrid.min.js');

    $response->assertOk();
    expect($response->headers->get('Content-Type'))->toContain('javascript');
    expect($response->headers->get('Cache-Control'))->toContain('immutable');
    expect($response->headers->get('ETag'))->not->toBeNull();
});

it('serves the bundled css over the internal route', function () {
    $this->get('/laragrid/laragrid.min.css')
        ->assertOk()
        ->assertHeader('Content-Type', 'text/css; charset=utf-8');
});

it('rejects files outside the whitelist', function () {
    $this->get('/laragrid/..%2fcomposer.json')->assertNotFound();
    $this->get('/laragrid/evil.php')->assertNotFound();
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
