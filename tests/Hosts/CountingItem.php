<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

/**
 * What: ExportItem that counts its toArray() conversions — the probe behind the "one array
 *       view per serialized row" guarantee of RowSerializer and ExportBuilder.
 *
 * When: tests/Feature/RelationLoadingTest; reset the counter before each measurement.
 */
class CountingItem extends ExportItem
{
    public static int $toArrayCalls = 0;

    protected $table = 'export_items';

    public function toArray(): array
    {
        static::$toArrayCalls++;

        return parent::toArray();
    }
}
