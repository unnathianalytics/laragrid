<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Route;
use LaraGrid\Http\AssetController;

/*
 * The internal asset route (Livewire delivery model): dist/ files served from the vendor
 * directory. Loaded via ServiceProvider::loadRoutesFrom(), so route caching handles it.
 * No web middleware — the assets are public static files; session/CSRF would only add cost.
 */
Route::get('/laragrid/{file}', AssetController::class)
    ->where('file', '[A-Za-z0-9._-]+')
    ->name('laragrid.asset');
