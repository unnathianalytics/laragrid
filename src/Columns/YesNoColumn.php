<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: A boolean column the operator answers by TYPING — 'Y' commits true, 'N' commits false,
 *       and either keystroke advances exactly like an Enter commit (the Tally Yes/No field: one
 *       key answers the cell and moves on). Space/double-click keep the checkbox's stay-put
 *       toggle; every other printable is ignored, so the cell accepts only Y or N.
 *
 * Why:  A CheckboxColumn deliberately has NO typed entry (Space is its gesture) and Space never
 *       advances — fine for an occasional flag, friction in a keyboard entry flow that runs
 *       through the cell on every row. Painted as 'Y'/'N' text (blank while unanswered, so a
 *       required cell's Enter block reads honestly), parsed by the 'yn' kind on both runtimes
 *       (parseYn ↔ YnCast — the bool truthy set plus 'y'), and committed through the same shared
 *       instant pipeline as the checkbox.
 *
 * When: Editable Yes/No answers on line grids the operator types through (e.g. bill-wise? /
 *       taxable?). Readonly grids just paint it.
 */
final class YesNoColumn extends Column
{
    protected function configureDefaults(): void
    {
        $this->defaultAlign('center');
    }

    public function painterId(): string
    {
        return 'yesno';
    }

    public function editorId(): string
    {
        return 'yesno';
    }

    /**
     * @return array<string, mixed>
     */
    public function parseSpec(): array
    {
        return ['kind' => 'yn'];
    }

    /**
     * @return list<mixed>
     */
    public function implicitRules(): array
    {
        return ['boolean'];
    }
}
