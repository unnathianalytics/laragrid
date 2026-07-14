<?php

declare(strict_types=1);

namespace LaraGrid\Filters;

use Closure;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * What: A single-value equality filter over one column — e.g. "Group = 5" — with an options
 *       map (value => label) the client renders as a select control.
 *
 * Why:  The commonest register filter (item group, account group, branch): pick one, narrow to
 *       matching rows. The value is compared with a bound `where(column, value)` so nothing the
 *       client sends reaches SQL uninterpolated (G12). ->column() lets the filter key differ from
 *       the DB column when needed; it defaults to the key.
 *
 * When: Grid->filters([SelectFilter::make('item_group_id')->label('Group')->options(...)]).
 */
final class SelectFilter extends Filter
{
    protected ?string $column = null;

    /**
     * @var (Closure(): iterable<int|string, string>)|iterable<int|string, string>|null
     */
    protected Closure|iterable|null $options = null;

    /**
     * Override the DB column compared (defaults to the filter key).
     */
    public function column(string $column): self
    {
        $this->column = $column;

        return $this;
    }

    /**
     * The selectable options as a {value => label} map, or a closure returning one (deferred so
     * a tenant-scoped lookup runs at serialize time, inside the host's bound tenant).
     *
     * @param  (Closure(): iterable<int|string, string>)|iterable<int|string, string>  $options
     */
    public function options(Closure|iterable $options): self
    {
        $this->options = $options;

        return $this;
    }

    /**
     * @param  Builder<covariant Model>  $query
     */
    public function apply(Builder $query, mixed $value): void
    {
        $query->where($this->column ?? $this->key, '=', $value);
    }

    /**
     * @return array{key: string, label: string, kind: string, options: array<int|string, string>}
     */
    public function toArray(): array
    {
        return [
            'key' => $this->key,
            'label' => $this->resolvedLabel(),
            'kind' => $this->kind(),
            'options' => $this->resolveOptions($this->options),
        ];
    }
}
