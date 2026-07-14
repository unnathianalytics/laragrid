<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: A plain left-aligned text column rendered via the generic text painter.
 *
 * Why:  The workhorse display column for codes, names and remarks. It carries no default
 *       format (the client falls back to the 'text' formatter), keeping it the neutral base
 *       against which the numeric/date types define their overrides.
 *
 * When: Any string-valued column in a readonly grid.
 */
final class TextColumn extends Column
{
    protected function configureDefaults(): void
    {
        $this->defaultAlign('left');
    }

    public function painterId(): string
    {
        return 'text';
    }

    /** Edited with the plain text editor. */
    public function editorId(): string
    {
        return 'text';
    }

    /**
     * Text is parsed as a trimmed string, honouring the column's optional case transform.
     *
     * @return array{kind: string, case: string|null}
     */
    public function parseSpec(): array
    {
        return ['kind' => 'text', 'case' => $this->getCaseTransform()];
    }
}
