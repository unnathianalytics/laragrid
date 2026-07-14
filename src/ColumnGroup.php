<?php

declare(strict_types=1);

namespace LaraGrid;

/**
 * What: A two-tier header group — a label spanning a set of member column keys (e.g. "Tax"
 *       over cgst/sgst/igst).
 *
 * Why:  GST registers and similar reports need a grouped top header; supporting it from M1
 *       is cheap in the header renderer and painful to retrofit (plan §1.4). The group only
 *       names its members by key; the serializer validates they exist and computes the span,
 *       so the group definition stays a thin declaration.
 *
 * When: Passed to Grid->columnGroups([...]); the client's HeaderRenderer draws a two-row
 *       header when any group is present.
 */
final class ColumnGroup
{
    /**
     * @param  list<string>  $columns  Member column keys, in display order.
     */
    private function __construct(
        public readonly string $label,
        public readonly array $columns,
    ) {}

    /**
     * @param  array<int|string, string>  $columns  Member column keys (re-indexed to a list).
     */
    public static function make(string $label, array $columns): self
    {
        return new self($label, array_values($columns));
    }

    /**
     * The declarative fragment: {label, columns}. The serializer adds the resolved span.
     *
     * @return array{label: string, columns: list<string>}
     */
    public function toArray(): array
    {
        return ['label' => $this->label, 'columns' => $this->columns];
    }
}
