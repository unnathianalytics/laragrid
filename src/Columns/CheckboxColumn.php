<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: A boolean column painted as a CSS-drawn check mark and toggled INLINE — Space (or
 *       Enter-to-edit/double-click) flips the value directly in NAV mode with no floating
 *       editor round-trip (umbrella §2.6: "Checkbox cells toggle in NAV directly").
 *
 * Why:  A checkbox has exactly two states; opening an editor to flip one is friction. The client
 *       registers a marker "instant" editor (CheckboxInline) that the EditorManager short-circuits
 *       into the SHARED commit pipeline (parse → validate → optimistic apply → op) — one write
 *       path, no second commit route. The value is cast to a real bool on both runtimes (parse
 *       kind 'bool') and guarded by an implicit `boolean` rule server-side.
 *
 * When: Editable flags on line grids (e.g. urgent / include-in-tax). Readonly grids just paint it.
 */
final class CheckboxColumn extends Column
{
    protected function configureDefaults(): void
    {
        $this->defaultAlign('center');
    }

    public function painterId(): string
    {
        return 'checkbox';
    }

    public function editorId(): string
    {
        return 'checkbox';
    }

    /**
     * @return array<string, mixed>
     */
    public function parseSpec(): array
    {
        return ['kind' => 'bool'];
    }

    /**
     * @return list<mixed>
     */
    public function implicitRules(): array
    {
        return ['boolean'];
    }
}
