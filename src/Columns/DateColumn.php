<?php

declare(strict_types=1);

namespace LaraGrid\Columns;

/**
 * What: A left-aligned date column. The model value is always ISO `Y-m-d` (stable, sortable);
 *       painting renders a display pattern (default d-m-Y) via the 'date' formatter. In an
 *       editable grid (M5) it opens the DateEditor: freeform Busy-style input (`31/12`,
 *       `31.12.26`, `311226`) resolved by the SHARED form-kit parser — including inferring a
 *       missing year from the financial-year window — and committed as canonical ISO.
 *
 * Why:  Dates travel the wire as ISO strings and only become the configured display pattern at
 *       paint time. The fuzzy parse lives in ONE place (the shared client date parser): the
 *       client resolves what the operator typed and the op carries the canonical ISO value, so
 *       the server needs no second fuzzy parser — it strictly casts and guards with an implicit
 *       date_format rule. Financial-year year-inference is OPT-IN (config laragrid.date
 *       .fy_start_month, or per column via ->financialYear()); the neutral default parses
 *       plain calendar dates.
 *
 * When: Any date-valued column (invoice date, delivery date); editable wherever the grid is.
 */
final class DateColumn extends Column
{
    /**
     * 1-indexed month the financial year starts, or null when FY year-inference is disabled
     * (plain calendar parsing). Seeded from config('laragrid.date.fy_start_month') — which
     * ships null — and overridable per column via ->financialYear().
     */
    protected ?int $fyStartMonth = null;

    /** Calendar year the current FY starts in; null = inferred from today at serialize time. */
    protected ?int $fyStartYear = null;

    /**
     * Override the display pattern (PHP date() syntax; the JS port maps the common tokens).
     */
    public function displayFormat(string $pattern): static
    {
        $this->format('date', ['display' => $pattern]);

        return $this;
    }

    /**
     * Enable financial-year year-inference for typed input missing a year (e.g. `31/12`): the
     * inferred year places the date inside the FY starting at $startMonth. Pass $startYear to
     * pin the window explicitly (hosts with company context); null infers it from today.
     */
    public function financialYear(int $startMonth, ?int $startYear = null): static
    {
        $this->fyStartMonth = min(12, max(1, $startMonth));
        $this->fyStartYear = $startYear;

        return $this;
    }

    protected function configureDefaults(): void
    {
        $this->defaultAlign('left');
        $this->defaultFormat('date', ['display' => (string) (config('laragrid.date.display') ?? 'd-m-Y')]);

        $month = config('laragrid.date.fy_start_month');
        $this->fyStartMonth = $month === null ? null : min(12, max(1, (int) $month));
    }

    public function painterId(): string
    {
        return 'text';
    }

    public function editorId(): string
    {
        return 'date';
    }

    /**
     * FY keys are emitted only when inference is enabled (the additive-config discipline);
     * without them the client date parser stays in plain calendar mode.
     *
     * @return array<string, mixed>
     */
    public function parseSpec(): array
    {
        $spec = ['kind' => 'date'];

        if ($this->fyStartMonth !== null) {
            $spec['fyStartMonth'] = $this->fyStartMonth;
            $spec['fyStartYear'] = $this->resolvedFyStartYear();
        }

        return $spec;
    }

    /**
     * The op value is client-resolved canonical ISO (decision 1); the server guard is a strict
     * format check — anything else is a validation error, never a silent guess.
     *
     * @return list<mixed>
     */
    public function implicitRules(): array
    {
        return ['date_format:Y-m-d'];
    }

    /**
     * The FY start year: the explicit override, else inferred from today (a date in/after the
     * start month belongs to this calendar year's FY, else the previous one) — mirroring the
     * shared client date parser's fallback.
     */
    protected function resolvedFyStartYear(): int
    {
        if ($this->fyStartYear !== null) {
            return $this->fyStartYear;
        }

        $now = now();

        return $now->month >= ($this->fyStartMonth ?? 1) ? $now->year : $now->year - 1;
    }
}
