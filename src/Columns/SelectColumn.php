<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

use Illuminate\Validation\Rule;
use LaraGrid\Columns\Concerns\HasOptions;

/**
 * What: A picker column over a small EMBEDDED option set (value => label), edited through the
 *       popup SelectEditor (type-ahead filter, arrows, Enter) and painted as the option's label.
 *
 * Why:  Fixed short lists (UoM, Dr/Cr, voucher sub-type) don't warrant a server round-trip per
 *       open — the options ship once in config and the client filters locally. Because the whole
 *       list crosses to every viewer, this column is for small, non-sensitive, tenant-invariant
 *       sets ONLY (the form-kit combobox client/server rule); tenant-scoped or large sets belong
 *       on SearchSelectColumn. Writes are fail-closed: an implicit in: rule derived from the
 *       embedded values rejects any value outside the list server-side (G12), so the whitelist
 *       is enforced even against a hand-crafted op.
 *
 * When: Declared on editable grids (e.g. a line's UoM). In a readonly grid it just paints labels.
 */
final class SelectColumn extends Column
{
    use HasOptions;

    public function painterId(): string
    {
        return 'select';
    }

    public function editorId(): string
    {
        return 'select';
    }

    /**
     * @return array<string, mixed>
     */
    public function parseSpec(): array
    {
        return ['kind' => 'select'];
    }

    /**
     * The embedded whitelist rule: a written value must be one of the declared option values.
     * Rule::in() (not an "in:" string) so option values containing commas can't break the rule.
     *
     * @return list<mixed>
     */
    public function implicitRules(): array
    {
        return $this->options === [] ? [] : [Rule::in($this->optionValues())];
    }

    /**
     * @return array<string, mixed>
     */
    protected function serializeType(): array
    {
        return ['options' => $this->options];
    }
}
