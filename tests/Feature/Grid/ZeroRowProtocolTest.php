<?php

declare(strict_types=1);

use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Editing\OpResult;
use LaraGrid\Grid;
use LaraGrid\Support\RowSerializer;
use LaraGrid\Tests\Hosts\ZeroRowEditableGridComponent;
use Livewire\Livewire;

function optionalAutoAppendGrid(int $minRows = 0): Grid
{
    return Grid::make('lines')
        ->editable()
        ->rowsFrom('lines')
        ->authorize(fn (): bool => true)
        ->autoAppend()
        ->minRows($minRows)
        ->newRowUsing(fn (): array => ['qty' => 1])
        ->columns([
            TextColumn::make('name'),
            IntegerColumn::make('qty'),
        ]);
}

function replaceOnlyRow(array $row, string $draftKey = 'draft-new'): OpResult
{
    $batch = OpBatch::fromPayload(['ops' => [
        ['t' => 'remove', 'seq' => 1, 'row' => $row['_k']],
        ['t' => 'insert', 'seq' => 2, 'as' => $draftKey],
    ]]);

    return (new OpApplier)->apply(optionalAutoAppendGrid(), [$row], $batch);
}

it('applies sole-filled-row removal and draft insertion as one server batch', function () {
    $result = replaceOnlyRow(['_k' => 'filled-old', 'name' => 'Old line', 'qty' => 2]);

    expect(array_column($result->results, 'ok'))->toBe([true, true])
        ->and($result->rows)->toHaveCount(1)
        ->and($result->rows[0])->toMatchArray([
            '_k' => 'draft-new',
            'name' => null,
            'qty' => 1,
        ])
        ->and($result->rows[0]['_k'])->not->toBe('filled-old')
        ->and((new RowSerializer)->cleanEditableRows(optionalAutoAppendGrid(), $result->rows))->toBe([]);
});

it('replaces a sole blank server row with a freshly keyed factory draft', function () {
    $result = replaceOnlyRow(['_k' => 'blank-old', 'name' => null, 'qty' => 1]);

    expect($result->rows)->toHaveCount(1)
        ->and($result->rows[0]['_k'])->toBe('draft-new')
        ->and($result->rows[0]['_k'])->not->toBe('blank-old')
        ->and((new RowSerializer)->cleanEditableRows(optionalAutoAppendGrid(), $result->rows))->toBe([]);
});

it('keeps the bound Livewire rows and gridRows synchronized on the replacement key', function () {
    $component = Livewire::test(ZeroRowEditableGridComponent::class)
        ->set('lines', [['_k' => 'wire-old', 'name' => 'Old line', 'qty' => 2]])
        ->call('gridOps', 'lines', ['ops' => [
            ['t' => 'remove', 'seq' => 1, 'row' => 'wire-old'],
            ['t' => 'insert', 'seq' => 2, 'as' => 'wire-draft'],
        ]]);

    $rows = $component->get('lines');
    expect($rows)->toHaveCount(1)
        ->and($rows[0]['_k'])->toBe('wire-draft')
        ->and($rows[0]['qty'])->toBe(1)
        ->and($component->instance()->logicalLines())->toBe([]);
});

it('leaves minRows(1) refusal unchanged', function () {
    $rows = [['_k' => 'required', 'name' => 'Must stay', 'qty' => 1]];
    $result = (new OpApplier)->apply(
        optionalAutoAppendGrid(1),
        $rows,
        OpBatch::fromPayload(['ops' => [
            ['t' => 'remove', 'seq' => 1, 'row' => 'required'],
        ]]),
    );

    expect($result->results[0]['ok'])->toBeFalse()
        ->and($result->results[0]['rows'])->toBe($rows)
        ->and($result->rows)->toBe($rows);
});
