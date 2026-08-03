<?php

declare(strict_types=1);

namespace Tests\Feature\Grid;

use LaraGrid\Columns\DateColumn;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\FocusMode;
use LaraGrid\Columns\ReadonlyColumn;
use LaraGrid\Columns\SelectColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Tests\TestCase;

final class FocusModeTest extends TestCase
{
    public function test_default_focus_mode_is_always_for_editable_columns(): void
    {
        $col = TextColumn::make('name');

        $this->assertSame(FocusMode::Always, $col->getFocusMode());
        $this->assertTrue($col->isNavigable());

        $serialized = $col->toArray();
        $this->assertSame('always', $serialized['focusMode']);
        $this->assertTrue($serialized['navigable']);
    }

    public function test_readonly_column_defaults_to_focus_mode_never(): void
    {
        $readonlyCol = ReadonlyColumn::make('created_at');

        $this->assertSame(FocusMode::Never, $readonlyCol->getFocusMode());
        $this->assertFalse($readonlyCol->isNavigable());

        $serialized = $readonlyCol->toArray();
        $this->assertSame('never', $serialized['focusMode']);
        $this->assertFalse($serialized['navigable']);

        $textCol = TextColumn::make('vch_date')->readonly();
        $this->assertSame(FocusMode::Never, $textCol->getFocusMode());
        $this->assertFalse($textCol->isNavigable());
    }

    public function test_focus_mode_manual_configuration_and_serialization(): void
    {
        $col = DecimalColumn::make('qty')
            ->label('Quantity')
            ->focusMode(FocusMode::Manual, default: 1);

        $this->assertSame(FocusMode::Manual, $col->getFocusMode());
        $this->assertFalse($col->isNavigable());
        $this->assertSame(1, $col->getDefaultValue());
        $this->assertSame(1, $col->resolveDefaultValue());

        $serialized = $col->toArray();
        $this->assertSame('manual', $serialized['focusMode']);
        $this->assertFalse($serialized['navigable']);
        $this->assertSame(1, $serialized['default']);
    }

    public function test_default_value_accepts_closure_callback(): void
    {
        $col = DateColumn::make('date')
            ->focusMode(FocusMode::Never)
            ->default(fn () => '2026-08-03');

        $this->assertSame(FocusMode::Never, $col->getFocusMode());
        $this->assertSame('2026-08-03', $col->resolveDefaultValue());

        $serialized = $col->toArray();
        $this->assertSame('never', $serialized['focusMode']);
        $this->assertSame('2026-08-03', $serialized['default']);
    }

    public function test_grid_make_new_row_populates_column_default_values(): void
    {
        $grid = Grid::make('test_grid')
            ->columns([
                DateColumn::make('date')->focusMode(FocusMode::Never, default: '2026-08-03'),
                SelectColumn::make('sale_type')->focusMode(FocusMode::Manual, default: 'L/GST-TaxIncl.'),
                TextColumn::make('party')->focusMode(FocusMode::Always, default: fn () => 'Cash'),
                DecimalColumn::make('qty')->focusMode(FocusMode::Manual, default: 1),
            ])
            ->editable()
            ->rowsFrom('lines')
            ->authorize(fn () => true);

        $row = $grid->makeNewRow('row_1');

        $this->assertSame('row_1', $row['_k']);
        $this->assertSame('2026-08-03', $row['date']);
        $this->assertSame('L/GST-TaxIncl.', $row['sale_type']);
        $this->assertSame('Cash', $row['party']);
        $this->assertSame(1, $row['qty']);
    }

    public function test_grid_new_row_using_overrides_column_defaults(): void
    {
        $grid = Grid::make('test_grid')
            ->columns([
                SelectColumn::make('sale_type')->focusMode(FocusMode::Manual, default: 'L/GST-TaxIncl.'),
                DecimalColumn::make('qty')->focusMode(FocusMode::Manual, default: 1),
            ])
            ->editable()
            ->newRowUsing(fn () => ['qty' => 5])
            ->rowsFrom('lines')
            ->authorize(fn () => true);

        $row = $grid->makeNewRow('row_2');

        $this->assertSame('L/GST-TaxIncl.', $row['sale_type']);
        $this->assertSame(5, $row['qty']);
    }
}
