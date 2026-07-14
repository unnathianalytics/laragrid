<?php

declare(strict_types=1);

namespace LaraGrid\Support;

/**
 * What: Server-side HTML fragments for ->html() grid cells — badges, per-row edit links,
 *       and the muted empty placeholder — rendered from tiny package Blade partials
 *       (resources/views/cells, published under vendor/laragrid for restyling).
 *
 * Why:  An ->html() cell paints caller-sanitised innerHTML (G13), so every fragment here is
 *       composed ONLY from Blade-escaped values — no free-text markup interpolation.
 *       Centralising the fragments keeps the G13 contract auditable in one place, and the
 *       partials use stable lgrid-* classes (no UI-kit components) so the package renders
 *       correctly in any host app; publish the views to re-skin.
 *
 * When: Called inside ComputedColumn::state() closures at row-serialize time.
 */
class CellHtml
{
    /**
     * A small static badge (safe inside the grid's wire:ignore body — no JS behaviour).
     * $color becomes a `lgrid-badge--{color}` modifier; the stylesheet ships a small palette
     * and unknown colors fall back to the neutral badge tone.
     */
    public static function badge(string $color, string $label, string $class = ''): string
    {
        return trim(view('laragrid::cells.badge', [
            'color' => $color,
            'label' => $label,
            'class' => $class,
        ])->render());
    }

    /**
     * The per-row Edit link. A plain full-navigation anchor — wire:navigate is deliberately
     * NOT painted here because the grid body is wire:ignore'd innerHTML, where the directive
     * would be a silent no-op.
     */
    public static function editLink(string $href): string
    {
        return trim(view('laragrid::cells.edit-link', ['href' => $href])->render());
    }

    /**
     * The muted em-dash placeholder for an empty optional value (classic-table parity).
     */
    public static function muted(): string
    {
        return '<span class="lgrid-muted">—</span>';
    }
}
