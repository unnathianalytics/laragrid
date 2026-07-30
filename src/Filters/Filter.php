<?php

declare(strict_types=1);

namespace LaraGrid\Filters;

use Closure;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Model;

/**
 * What: The abstract base for a readonly-grid column filter — identity (key + label), an
 *       ->apply(Builder, $value) hook each concrete filter fills in, and a declarative
 *       ->toArray() fragment the client paints its control from.
 *
 * Why:  Filters are server-authoritative query narrowing (plan §2.4 Query, §3.1 readonly API):
 *       the client only holds the *value* a user picked and ships it to gridFetch; the actual
 *       WHERE runs here on the host, tenant-fenced by the host's global scope. Concentrating the
 *       common surface (key/label/options metadata + a no-op-on-empty guard) in the base keeps
 *       each concrete filter to just its apply logic and its serialized `kind`.
 *
 * When: Declared on a Grid via ->filters([...]); resolved by LaraGrid\Query\AppliesFilters when
 *       gridFetch runs, and serialized into config by ConfigSerializer so the pilot/toolbar can
 *       render the matching control (the in-header filter menu is M7; the pipeline is complete now).
 */
abstract class Filter
{
    protected ?string $label = null;

    /**
     * @param  string  $key  The filter identity; also the query-payload key the client sends.
     */
    final public function __construct(public readonly string $key) {}

    public static function make(string $key): static
    {
        return new static($key);
    }

    public function label(string $label): static
    {
        $this->label = $label;

        return $this;
    }

    /**
     * The resolved control label — the explicit label, else Title Case of the key.
     */
    public function resolvedLabel(): string
    {
        return $this->label ?? ucwords(str_replace(['_', '-'], ' ', $this->key));
    }

    /**
     * Whether a given client-supplied value is "active" (should narrow the query).
     *
     * Why: A blank/absent value means the filter is unset and must be a no-op — never a WHERE
     *      that accidentally excludes everything. Concrete filters override for their own empties
     *      (e.g. TernaryFilter treats 'any' as inactive).
     */
    public function isActive(mixed $value): bool
    {
        return $value !== null && $value !== '';
    }

    /**
     * Whether a value is still a LEGAL choice for this filter right now.
     *
     * Why: isActive() answers "does this narrow anything"; this answers "does this value still
     *      exist". They differ only for a RESTORED value — one that ->persistQuery() stored in a
     *      previous request, or that a saved view is replaying. Between then and now the operator
     *      may have switched tenant, or the referenced record may have been deleted, and replaying
     *      a stale id would silently empty the list with no visible cause. Concrete filters that
     *      know their legal set (SelectFilter's options, TernaryFilter's three states) override;
     *      the base accepts anything, because a filter over an open value space (a free-text or
     *      range filter) has nothing to check against.
     *
     * When: ViewState::sanitizeQuery, on every stored/replayed filter value.
     */
    public function accepts(mixed $value): bool
    {
        return true;
    }

    /**
     * Narrow the query by the client-supplied value. Only called when isActive($value) is true.
     *
     * @param  Builder<covariant Model>  $query
     */
    abstract public function apply(Builder $query, mixed $value): void;

    /**
     * The declarative fragment the client renders its control from: {key, label, kind, ...}.
     *
     * @return array<string, mixed>
     */
    abstract public function toArray(): array;

    /**
     * The short kind tag emitted into config (e.g. 'select' for SelectFilter) — the class base
     * name minus the "Filter" suffix, lower-cased.
     */
    protected function kind(): string
    {
        $base = class_basename(static::class);

        return mb_strtolower(str_ends_with($base, 'Filter') ? substr($base, 0, -6) : $base);
    }

    /**
     * Resolve an options closure (or array) into a plain {value => label} map for the config.
     *
     * @param  (Closure(): iterable<int|string, string>)|iterable<int|string, string>|null  $options
     * @return array<int|string, string>
     */
    protected function resolveOptions(Closure|iterable|null $options): array
    {
        if ($options === null) {
            return [];
        }

        $resolved = $options instanceof Closure ? $options() : $options;

        return collect($resolved)->all();
    }
}
