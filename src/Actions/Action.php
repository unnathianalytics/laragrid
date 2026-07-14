<?php

declare(strict_types=1);

namespace LaraGrid\Actions;

use Closure;
use InvalidArgumentException;

/**
 * What: One declarative action — a per-row button, a bulk (checked-rows) operation, or a
 *       toolbar button — in exactly one of two kinds: `url` (navigation; resolved
 *       server-side and baked onto the row like `_activateUrl`) or `call` (a host closure
 *       run through the fail-closed gridAction RPC).
 *
 * Why:  Actions follow the grid's core security posture: the client never builds a URL and
 *       never names a method — it only echoes an action NAME back to the host, where the
 *       grid gate, the per-action ->authorize() gate and the per-row ->visible() predicate
 *       are ALL re-checked before the closure runs (a hidden button must also be an
 *       unusable button). ->confirm() rides the grid's own popup, keyboard-first.
 *
 * When: Declared on Grid ->actions([...]) / ->bulkActions([...]) / ->toolbarActions([...]).
 */
class Action
{
    protected ?string $label = null;

    /** A glyph/emoji/short string rendered before the label (e.g. '✎'); no icon-font dependency. */
    protected ?string $icon = null;

    /** Confirm message shown (grid popup) before a call action runs; null = no confirm. */
    protected ?string $confirm = null;

    /**
     * URL resolver — row actions: fn (array $row): ?string (null = inert for that row);
     * toolbar actions: fn (): ?string (resolved once at serialize).
     */
    protected ?Closure $urlUsing = null;

    /**
     * The server callback — row: fn (array $row): void; bulk: fn (list<string> $keys): void;
     * toolbar: fn (): void. Throw Illuminate\Validation\ValidationException for an
     * operator-facing refusal message.
     */
    protected ?Closure $callUsing = null;

    /** Per-row visibility predicate: fn (array $row): bool. Server-evaluated, re-checked on call. */
    protected ?Closure $visibleUsing = null;

    /** Per-action authorization — Closure or ability string, re-checked on every call. */
    protected Closure|string|null $authorizeUsing = null;

    final public function __construct(public readonly string $name) {}

    public static function make(string $name): static
    {
        return new static($name);
    }

    public function label(string $label): static
    {
        $this->label = $label;

        return $this;
    }

    public function icon(string $icon): static
    {
        $this->icon = $icon;

        return $this;
    }

    /**
     * Navigation action. Row scope: fn (array $row): ?string — return null to hide the
     * button on that row (mirrors rowActivate's permission gate). Toolbar scope: fn (): ?string.
     */
    public function url(Closure $resolver): static
    {
        $this->urlUsing = $resolver;

        return $this;
    }

    /**
     * Server-callback action, run via the gridAction RPC behind the grid's authorize gate
     * plus this action's own (->authorize()).
     */
    public function call(Closure $callback): static
    {
        $this->callUsing = $callback;

        return $this;
    }

    /** Require a confirmation (grid popup, keyboard-first) before the call runs. */
    public function confirm(string $message): static
    {
        $this->confirm = $message;

        return $this;
    }

    /**
     * @param  Closure(array<string, mixed>): bool  $predicate
     */
    public function visible(Closure $predicate): static
    {
        $this->visibleUsing = $predicate;

        return $this;
    }

    /**
     * @param  Closure(): mixed|string  $ability
     */
    public function authorize(Closure|string $ability): static
    {
        $this->authorizeUsing = $ability;

        return $this;
    }

    // ---- Accessors ------------------------------------------------------------------------

    public function resolvedLabel(): string
    {
        return $this->label ?? ucwords(str_replace(['_', '-'], ' ', $this->name));
    }

    public function getIcon(): ?string
    {
        return $this->icon;
    }

    public function getConfirm(): ?string
    {
        return $this->confirm;
    }

    public function hasUrl(): bool
    {
        return $this->urlUsing !== null;
    }

    public function hasCall(): bool
    {
        return $this->callUsing !== null;
    }

    public function getCall(): ?Closure
    {
        return $this->callUsing;
    }

    /**
     * @return (Closure(): mixed)|string|null
     */
    public function getAuthorization(): Closure|string|null
    {
        return $this->authorizeUsing;
    }

    /**
     * @param  array<string, mixed>  $row
     */
    public function isVisibleFor(array $row): bool
    {
        return $this->visibleUsing === null || (bool) ($this->visibleUsing)($row);
    }

    /**
     * Resolve the URL — row scope passes the row; toolbar scope passes nothing.
     *
     * @param  array<string, mixed>|null  $row
     */
    public function resolveUrl(?array $row = null): ?string
    {
        if ($this->urlUsing === null) {
            return null;
        }

        $url = $row === null ? ($this->urlUsing)() : ($this->urlUsing)($row);

        return is_string($url) && $url !== '' ? $url : null;
    }

    /**
     * Structural self-check, run from Grid::assertValid with the grid/scope context.
     */
    public function assertValid(string $grid, string $scope): void
    {
        if ($this->urlUsing === null && $this->callUsing === null) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] {$scope} action [{$this->name}] declares neither url() nor call()."
            );
        }

        if ($this->urlUsing !== null && $this->callUsing !== null) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] {$scope} action [{$this->name}] declares BOTH url() and call(); pick one."
            );
        }

        if ($scope === 'bulk' && $this->callUsing === null) {
            throw new InvalidArgumentException(
                "Grid [{$grid}] bulk action [{$this->name}] must be a call() action (a url cannot span rows)."
            );
        }
    }

    /**
     * The declarative client fragment (never the closures).
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $fragment = [
            'name' => $this->name,
            'label' => $this->resolvedLabel(),
            'kind' => $this->hasUrl() ? 'url' : 'call',
        ];

        if ($this->icon !== null) {
            $fragment['icon'] = $this->icon;
        }

        if ($this->confirm !== null) {
            $fragment['confirm'] = $this->confirm;
        }

        return $fragment;
    }
}
