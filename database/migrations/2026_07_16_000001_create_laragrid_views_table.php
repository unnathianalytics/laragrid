<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Saved grid views (LaraGrid): one row per operator + grid + view name, holding the sanitized
 * view state as JSON text. Auto-loaded with the package; publish with
 * `php artisan vendor:publish --tag=laragrid-migrations` to customise (the hasTable guard
 * keeps a published copy and the packaged copy from double-creating).
 */
return new class extends Migration
{
    public function up(): void
    {
        $table = (string) config('laragrid.views.table', 'laragrid_views');

        if (Schema::hasTable($table)) {
            return;
        }

        Schema::create($table, function (Blueprint $table): void {
            $table->id();
            $table->string('scope', 64);
            $table->string('grid_key', 100);
            $table->string('name', 60);
            $table->text('state');
            $table->timestamps();

            $table->unique(['scope', 'grid_key', 'name']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists((string) config('laragrid.views.table', 'laragrid_views'));
    }
};
