<?php

declare(strict_types=1);

namespace LaraGrid\Tests\Hosts;

use Closure;
use Illuminate\Contracts\View\View;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\FormulaColumn;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\SearchSelectColumn;
use LaraGrid\Columns\SelectColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\RowContext;
use LaraGrid\Grid;
use LaraGrid\Livewire\WithLaraGrid;
use Livewire\Component;

/**
 * What: A voucher-lines editable host — D/C side, a server-mode account picker whose options
 *       depend on the side and whose pick enriches the rate, an integer quantity, a scale-2 rate
 *       and a `qty * rate` formula. A test can extend the grid definition through $tune.
 *
 * Why:  The editable-shortlist features (calculator entry, live classes, paste by label, row
 *       move, grid-level validation, change sets) all need the same realistic line shape on a
 *       real Livewire request path; one host with a tuning seam avoids a host per feature.
 *
 * When: tests/Feature — Livewire::test(VoucherLinesGridComponent::class). Call resetTuning()
 *       in afterEach when a test sets $tune or $catalogue.
 */
class VoucherLinesGridComponent extends Component
{
    use WithLaraGrid;

    /**
     * Extra grid configuration a test applies: fn (Grid $grid): Grid.
     *
     * @var (Closure(Grid): Grid)|null
     */
    public static ?Closure $tune = null;

    /**
     * The account master the picker searches: list of {value, label, side, rate}.
     *
     * @var list<array{value: string, label: string, side: string, rate: string}>
     */
    public static array $catalogue = [];

    /** How many times the picker's optionsUsing closure ran (paste-by-label memo checks). */
    public static int $searches = 0;

    /**
     * Lines mount() assigns directly (an existing document loaded without gridMountRows() or
     * reseedGrid()); null mounts a fresh document.
     *
     * @var list<array<string, mixed>>|null
     */
    public static ?array $mountLines = null;

    /** @var list<array<string, mixed>> */
    public array $lines = [];

    public function mount(): void
    {
        $this->lines = self::$mountLines ?? $this->gridMountRows('lines');
    }

    /** @return list<array{value: string, label: string, side: string, rate: string}> */
    public static function defaultCatalogue(): array
    {
        return [
            ['value' => 'a1', 'label' => 'Cement 50kg', 'side' => 'D', 'rate' => '350.00'],
            ['value' => 'a2', 'label' => 'Steel Rod 12mm', 'side' => 'D', 'rate' => '72.50'],
            ['value' => 'a3', 'label' => 'Sand', 'side' => 'D', 'rate' => '40.00'],
            ['value' => 'a4', 'label' => 'Sand', 'side' => 'D', 'rate' => '45.00'],
            ['value' => 'c1', 'label' => 'Cash', 'side' => 'C', 'rate' => '1.00'],
            ['value' => 'c2', 'label' => 'Cement 50kg', 'side' => 'C', 'rate' => '0.00'],
        ];
    }

    public static function resetTuning(): void
    {
        self::$tune = null;
        self::$catalogue = [];
        self::$searches = 0;
        self::$mountLines = null;
    }

    /**
     * @return array<string, Grid>
     */
    protected function grids(): array
    {
        $grid = Grid::make('lines')
            ->editable()
            ->rowsFrom('lines')
            ->authorize(fn (): bool => true)
            ->defaultRows(1)
            ->newRowUsing(fn (): array => ['dc' => 'D'])
            ->columns([
                SerialColumn::make(),
                SelectColumn::make('dc')->options(['D' => 'Dr', 'C' => 'Cr']),
                SearchSelectColumn::make('account_id')
                    ->optionsDependOn('dc')
                    ->optionsUsing(function (string $term, array $row): array {
                        self::$searches++;
                        $catalogue = self::$catalogue === [] ? self::defaultCatalogue() : self::$catalogue;
                        $side = (string) ($row['dc'] ?? '');

                        return array_values(array_filter(
                            $catalogue,
                            fn (array $a): bool => ($side === '' || $a['side'] === $side)
                                && ($term === '' || $a['value'] === $term || stripos($a['label'], $term) !== false),
                        ));
                    })
                    ->onSelect(function (RowContext $row, mixed $value): void {
                        $catalogue = self::$catalogue === [] ? self::defaultCatalogue() : self::$catalogue;
                        foreach ($catalogue as $account) {
                            if ($account['value'] === $value) {
                                $row->set('rate', $account['rate']);
                            }
                        }
                    }),
                TextColumn::make('narration'),
                IntegerColumn::make('qty'),
                DecimalColumn::make('rate')->scale(2),
                FormulaColumn::make('amount')->formula('qty * rate'),
            ]);

        return ['lines' => self::$tune !== null ? (self::$tune)($grid) : $grid];
    }

    /**
     * Test hook: open an existing document — assign its lines and reseed (the change-set baseline).
     *
     * @param  list<array<string, mixed>>  $lines
     */
    public function loadDocument(array $lines): void
    {
        $this->lines = $lines;
        $this->reseedGrid('lines');
    }

    /**
     * Test hook: the change set (gridChanges() is protected — host code only).
     *
     * @return array<string, mixed>
     */
    public function changes(): array
    {
        return $this->gridChanges('lines');
    }

    /** Test hook: the host saved without reseeding. */
    public function saved(): void
    {
        $this->markGridSaved('lines');
    }

    public function render(): View
    {
        return view('laragrid-tests::editable-grid');
    }
}
