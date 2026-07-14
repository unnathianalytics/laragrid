<?php

declare(strict_types=1);

namespace LaraGrid\Columns\Concerns;

/**
 * What: Fluent column sizing — a fixed width, min/max clamps, or a flexible "grow" column
 *       that absorbs leftover horizontal space.
 *
 * Why:  The client Layout module builds one grid-template-columns var from these numbers;
 *       expressing sizing declaratively on the PHP column (rather than in JS) keeps the
 *       whole layout describable from the host and serializable into config. "grow" maps to
 *       a CSS fr track so a wide column (e.g. an item name) can flex while the rest stay
 *       fixed — the pattern the M0 spike proved.
 *
 * When: Mixed into the Column base; read by ConfigSerializer into each column fragment.
 */
trait HasWidth
{
    /** Fixed pixel width, or null when the column grows / uses its default. */
    protected ?int $width = null;

    protected ?int $minWidth = null;

    protected ?int $maxWidth = null;

    /** When true the column takes a flexible fr track instead of a fixed width. */
    protected bool $grows = false;

    /**
     * Whether the operator may drag-resize this column (M7). On by default — a header drag
     * handle is harmless everywhere — so hosts only ever opt OUT (e.g. a tight action gutter).
     */
    protected bool $resizable = true;

    public function width(int $pixels): static
    {
        $this->width = $pixels;
        $this->grows = false;

        return $this;
    }

    public function minWidth(int $pixels): static
    {
        $this->minWidth = $pixels;

        return $this;
    }

    public function maxWidth(int $pixels): static
    {
        $this->maxWidth = $pixels;

        return $this;
    }

    public function grow(): static
    {
        $this->grows = true;
        $this->width = null;

        return $this;
    }

    /**
     * Opt this column out of (or back into) operator drag-resize.
     */
    public function resizable(bool $resizable = true): static
    {
        $this->resizable = $resizable;

        return $this;
    }

    public function isResizable(): bool
    {
        return $this->resizable;
    }

    /**
     * The sizing fragment serialized into the column's config. `resizable` is emitted ONLY
     * when a column opts out (the client defaults to resizable), so the committed golden
     * configs of columns that never touch it do not rot — the M6 `whenFilled` discipline.
     *
     * @return array{width: int|null, minWidth: int|null, maxWidth: int|null, grow: bool, resizable?: false}
     */
    protected function serializeWidth(): array
    {
        $fragment = [
            'width' => $this->width,
            'minWidth' => $this->minWidth,
            'maxWidth' => $this->maxWidth,
            'grow' => $this->grows,
        ];

        if (! $this->resizable) {
            $fragment['resizable'] = false;
        }

        return $fragment;
    }
}
