<?php

declare(strict_types=1);

namespace LaraGrid;

/**
 * What: The vertical row-density presets a Grid can render at.
 *
 * Why:  Density is a first-class layout dimension for accountants who want either an
 *       airy master list or a Tally-tight voucher grid. Modelling it as an enum (rather
 *       than a free string) keeps the serialized config closed to a known set the client
 *       CSS has a modifier class for (lgrid--compact / lgrid--comfortable; Normal is the
 *       token default with no modifier), so a typo can never ship an unstyled grid.
 *
 * When: Set on the Grid via ->density() and serialized into config.layout.density; the
 *       client Layout module maps the value to a root modifier class.
 */
enum GridDensity: string
{
    case Compact = 'compact';
    case Normal = 'normal';
    case Comfortable = 'comfortable';

    /**
     * The root modifier class this density selects, or null for the token default (Normal).
     *
     * Why: The client toggles exactly one density class on the grid root; Normal carries
     *      no class so the base tokens apply unmodified.
     */
    public function modifierClass(): ?string
    {
        return match ($this) {
            self::Compact => 'lgrid--compact',
            self::Comfortable => 'lgrid--comfortable',
            self::Normal => null,
        };
    }
}
