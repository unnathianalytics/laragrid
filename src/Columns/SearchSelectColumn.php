<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

use Closure;
use Illuminate\Validation\Rule;
use LaraGrid\Columns\Concerns\HasOptions;
use LaraGrid\Editing\RowContext;

/**
 * What: The async combobox column — the grid's item/account picker. Options come from a
 *       host-supplied, tenant-scoped closure searched per typed term over the renderless
 *       gridOptions RPC (server mode), or from a small embedded list (client mode). A pick can
 *       trigger the column's ->onSelect() server hook, which enriches the row (uom/tax/rate
 *       pre-fill — the generalisation of the voucher screen's updated() magic, umbrella §2.5.3).
 *
 * Why:  Master pickers are the heart of voucher entry: datasets are large and tenant-scoped, so
 *       the option search MUST run server-side inside the host's tenancy + the grid's authorize
 *       gate (G12) — never shipped wholesale to the client (the form-kit combobox client/server
 *       rule). The wire cost is bounded: per-term results are capped at ->limit() (default 10,
 *       hard cap 50) and sorted alphabetically so the operator sees a stable, scannable list.
 *       Rows carry the picked LABEL in the display-only `_labels` bag so painting never queries.
 *
 * When: Editable grids (item_id / account_id lines). The M5 demo pilots it; M6 wires real masters.
 */
final class SearchSelectColumn extends Column
{
    use HasOptions;

    /** The hard per-search result ceiling no ->limit() may exceed (umbrella §2.5.3). */
    public const MAX_LIMIT = 50;

    /**
     * The server option search: fn (string $term, array $row): iterable of {value, label(, meta)}
     * rows. Typed loosely (mixed items) because host closures aren't enforced — resolveOptions()
     * guards each row at runtime.
     *
     * @var (Closure(string, array<string, mixed>): iterable<int, mixed>)|null
     */
    protected ?Closure $optionsResolver = null;

    /**
     * Server hook fired after a pick is applied: fn (RowContext $row, mixed $value): void.
     *
     * @var (Closure(RowContext, mixed): void)|null
     */
    protected ?Closure $onSelectHook = null;

    /** Minimum typed characters before the client searches (type-to-search; user decision M5-Q4). */
    protected int $minChars = 1;

    /** Client debounce between typing and the option search, in milliseconds. */
    protected int $debounceMs = 250;

    /** Per-search result limit (alphabetical by label), clamped to MAX_LIMIT. */
    protected int $limit = 10;

    /**
     * Bind the tenant-scoped server option search. Declaring one puts the column in server mode
     * (any embedded ->options() are then ignored client-side).
     *
     * @param  Closure(string, array<string, mixed>): iterable<int, mixed>  $resolver
     */
    public function optionsUsing(Closure $resolver): static
    {
        $this->optionsResolver = $resolver;

        return $this;
    }

    /**
     * Server hook run after a pick on this column is applied — enrich the row through the
     * RowContext (set uom/tax/rate, label enrichments via setLabel). Write-backs ride the
     * op response patch the client reconciles.
     *
     * @param  Closure(RowContext, mixed): void  $hook
     */
    public function onSelect(Closure $hook): static
    {
        $this->onSelectHook = $hook;

        return $this;
    }

    public function minChars(int $chars): static
    {
        $this->minChars = max(0, $chars);

        return $this;
    }

    public function debounce(int $milliseconds): static
    {
        $this->debounceMs = max(0, $milliseconds);

        return $this;
    }

    /**
     * Cap each option search's result count (clamped to MAX_LIMIT = 50).
     */
    public function limit(int $limit): static
    {
        $this->limit = max(1, min($limit, self::MAX_LIMIT));

        return $this;
    }

    public function hasServerOptions(): bool
    {
        return $this->optionsResolver !== null;
    }

    /**
     * @return (Closure(RowContext, mixed): void)|null
     */
    public function getOnSelectHook(): ?Closure
    {
        return $this->onSelectHook;
    }

    /**
     * Run the server option search for a term + row context, normalising the closure's rows to
     * the canonical {value, label(, meta)} shape, sorting alphabetically by label, and clamping
     * to the column's limit — the cap is enforced HERE, not left to the closure (G12). `meta` is
     * an optional display-only annotation (e.g. stock on hand) the editor renders right-aligned
     * after the label; it is never part of the committed value.
     *
     * @param  array<string, mixed>  $row
     * @return list<array{value: string, label: string, meta?: string}>
     */
    public function resolveOptions(string $term, array $row = []): array
    {
        if ($this->optionsResolver === null) {
            return [];
        }

        $options = [];
        foreach (($this->optionsResolver)($term, $row) as $option) {
            if (! is_array($option)) {
                continue;
            }
            $value = (string) ($option['value'] ?? '');
            $normalized = ['value' => $value, 'label' => (string) ($option['label'] ?? $value)];

            $meta = (string) ($option['meta'] ?? '');
            if ($meta !== '') {
                $normalized['meta'] = $meta;
            }

            $options[] = $normalized;
        }

        usort($options, fn (array $a, array $b): int => strcasecmp($a['label'], $b['label']));

        return array_slice($options, 0, $this->limit);
    }

    public function painterId(): string
    {
        return 'select';
    }

    public function editorId(): string
    {
        return 'searchselect';
    }

    /**
     * @return array<string, mixed>
     */
    public function parseSpec(): array
    {
        return ['kind' => 'select'];
    }

    /**
     * Client-mode (embedded) columns get the same whitelist guard as SelectColumn; server-mode
     * validation is the author's declaration (an exists:/closure rule) — the dataset is too
     * large to inline.
     *
     * @return list<mixed>
     */
    public function implicitRules(): array
    {
        if ($this->hasServerOptions() || $this->options === []) {
            return [];
        }

        return [Rule::in($this->optionValues())];
    }

    /**
     * @return array<string, mixed>
     */
    protected function serializeType(): array
    {
        return [
            'optionsMode' => $this->hasServerOptions() ? 'server' : 'client',
            'options' => $this->hasServerOptions() ? [] : $this->options,
            'minChars' => $this->minChars,
            'debounceMs' => $this->debounceMs,
            'limit' => $this->limit,
        ];
    }
}
