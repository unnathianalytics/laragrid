<?php

declare(strict_types=1);

namespace LaraGrid\Filters;

use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * What: A tri-state boolean filter over one column — 'yes' / 'no' / 'any' — e.g. "Active: Yes".
 *
 * Why:  Boolean masters (is_active, is_default) read best as a three-way toggle: match true,
 *       match false, or don't filter. 'any' (the default) is inactive, so the base ->isActive()
 *       is overridden to treat it as unset. The value is normalised to a strict bool before a
 *       bound where(), so an unexpected client string can never widen the match.
 *
 * When: Grid->filters([TernaryFilter::make('is_active')->label('Active')]).
 */
final class TernaryFilter extends Filter
{
    protected ?string $column = null;

    /**
     * Override the DB column compared (defaults to the filter key).
     */
    public function column(string $column): self
    {
        $this->column = $column;

        return $this;
    }

    /**
     * 'any' (or blank/absent) means the filter is unset — a no-op. Only 'yes'/'no' narrow.
     */
    public function isActive(mixed $value): bool
    {
        return $value === 'yes' || $value === 'no' || $value === true || $value === false;
    }

    /**
     * @param  Builder<covariant Model>  $query
     */
    public function apply(Builder $query, mixed $value): void
    {
        $wantsTrue = $value === 'yes' || $value === true;
        $query->where($this->column ?? $this->key, '=', $wantsTrue);
    }

    /**
     * @return array{key: string, label: string, kind: string}
     */
    public function toArray(): array
    {
        return [
            'key' => $this->key,
            'label' => $this->resolvedLabel(),
            'kind' => $this->kind(),
        ];
    }
}
