# Recipe: Indian accounting flavor (INR, paise, quantities, financial-year dates)

LaraGrid's core is deliberately locale-neutral. The accounting app it was extracted from adds
its flavor back through the public registries — this recipe is that app's exact wiring, usable
as-is or as the template for any locale/domain of your own.

Rule of thumb: **every PHP registration needs a JS twin under the same name**, and each pair
should be pinned by a shared vector (see "Locking the pair" below).

## 1. The `paise` parse kind (integer-paise money)

Model rule: money is an integer number of paise end-to-end; operators type rupees.

```php
// app/Grid/PaiseCast.php
class PaiseCast implements \LaraGrid\Casting\Cast
{
    public function cast(mixed $value, array $spec, \LaraGrid\Columns\Column $column): int
    {
        $normalised = str_replace([',', ' '], '', (string) ($value ?? ''));

        return is_numeric($normalised)
            ? (int) round((float) $normalised * 100, 0, PHP_ROUND_HALF_UP)
            : 0;
    }
}

// AppServiceProvider::boot()
app(\LaraGrid\Casting\CastRegistry::class)->register('paise', new PaiseCast);
```

```js
// resources/js/laragrid-app.js (loaded after the LaraGrid bundle)
LaraGrid.registerCast('paise', {
    parse: (raw) => {
        const n = String(raw ?? '').replace(/[,\s]/g, '');
        if (n === '' || Number.isNaN(Number(n))) return 0;
        const shifted = Number(n) * 100;
        return Math.sign(shifted) * Math.round(Math.abs(shifted) + 1e-9); // half-up
    },
    // F2 / copy / paste interchange: 12500 paise edits as "125.00" (never raw paise digits).
    editText: (value) => Number.isFinite(Number(value)) ? (Number(value) / 100).toFixed(2) : '',
});
```

## 2. The `inr` and `qty` formatters (lakh/crore grouping)

```php
// PHP side — register alongside the cast:
$registry = app(\LaraGrid\Formatting\FormatRegistry::class);
$registry->register('inr', new InrFormatter);   // integer paise → "1,23,456.78"
$registry->register('qty', new QtyFormatter);   // "12,34,567.890" at scale (default 3)
```

Reference implementations (grouping = last three digits, then two-digit pairs) live verbatim in
this package's `tests/Feature/Grid/FormatVectorsTest.php` — copy them.

```js
const groupIndian = (d) => d.length <= 3 ? d
    : d.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + d.slice(-3);

LaraGrid.registerFormatter('inr', (value) => {
    if (value === null || value === undefined || value === '') return '';
    const paise = Math.trunc(Number(value)), neg = paise < 0, abs = Math.abs(paise);
    return (neg ? '-' : '') + groupIndian(String(Math.trunc(abs / 100)))
        + '.' + String(abs % 100).padStart(2, '0');
});

LaraGrid.registerFormatter('qty', (value, args) => {
    if (value === null || value === undefined || value === '') return '';
    const scale = Math.max(0, parseInt(args?.scale ?? 3, 10));
    const fixed = Number(value).toFixed(scale), neg = fixed.startsWith('-');
    const [i, f] = (neg ? fixed.slice(1) : fixed).split('.');
    return (neg ? '-' : '') + groupIndian(i) + (scale > 0 ? '.' + f : '');
});
```

## 3. App column types

```php
final class AmountColumn extends \LaraGrid\Columns\Column
{
    protected function configureDefaults(): void
    {
        $this->defaultAlign('right');
        $this->defaultFormat('inr');
    }

    public function painterId(): string { return 'text'; }
    public function editorId(): ?string { return 'number'; }
    public function parseSpec(): array { return ['kind' => 'paise']; }
    public function isSelectableNumeric(): bool { return true; }
}
```

Use it exactly like a core column: `AmountColumn::make('dr')->lockedWhen('dc', 'C')`. Footer
totals: `Aggregate::sum('dr')->format('inr')`.

## 4. Financial-year dates

```php
// config/laragrid.php — app-wide April FY (typed "31/12" infers the FY-correct year):
'date' => ['display' => 'd-m-Y', 'fy_start_month' => 4],

// or per column, pinned to a company's actual FY:
DateColumn::make('date')->financialYear(4, $company->fyStartYear);
```

No configuration = plain calendar dates. Nothing else changes.

## 5. Locking the pair (do not skip)

Add a vector for every registered name/kind to `tests/fixtures/grid-vectors/formats.json`
(or your app's copy) and assert it in BOTH runtimes — a Pest test through
`FormatRegistry::format()` / your `Cast`, and a Node run through `LaraGrid.registerFormatter`
/ `registerCast`. This package's own `FormatVectorsTest` + `tests/js/run-picker-vectors.mjs`
show the pattern, including registering app implementations through the public seams inside
the test itself. If the two runtimes ever disagree, the vector fails before your operators see
a mismatched cell.
