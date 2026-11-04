<?php

declare(strict_types=1);

use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\SelectColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Editing\OpApplier;
use LaraGrid\Editing\OpBatch;
use LaraGrid\Grid;
use LaraGrid\Support\ConfigSerializer;

/**
 * What: Live conditional formatting (plan F2). The declarative half: `classWhen` on a column and
 *       `layout.rowClassWhen` serialize only when declared and assertValid() guards them. The
 *       closure half: a SET or a fill on a grid with rowClass()/cellClass() closures carries the
 *       refreshed `_rowClass` / `_cellClass` in its patch only when the verdict changed; a grid
 *       without closures never does.
 *
 * Why:  The client evaluates the declarations instantly and adopts the closure verdicts from the
 *       op response; both ride the config/patch shape, which must stay byte-identical for grids
 *       that use neither.
 *
 * When: Fast Feature coverage.
 */
function classGrid(?Closure $tune = null): Grid
{
    $grid = Grid::make('lines')
        ->editable()->rowsFrom('lines')->authorize(fn (): bool => true)
        ->columns([
            SelectColumn::make('dc')->options(['D' => 'Dr', 'C' => 'Cr']),
            DecimalColumn::make('amount')->scale(2),
            TextColumn::make('memo'),
        ]);

    return $tune !== null ? $tune($grid) : $grid;
}

it('emits classWhen and layout.rowClassWhen only when declared', function () {
    $serializer = new ConfigSerializer;

    $plain = $serializer->serialize(classGrid(), []);
    foreach ($plain['columns'] as $column) {
        expect($column)->not->toHaveKey('classWhen');
    }
    expect($plain['layout'])->not->toHaveKey('rowClassWhen');

    $declared = $serializer->serialize(classGrid(fn (Grid $g): Grid => $g
        ->columns([
            SelectColumn::make('dc')->options(['D' => 'Dr', 'C' => 'Cr']),
            DecimalColumn::make('amount')->scale(2)
                ->classWhen('dc', 'C', 'is-credit')
                ->classWhen('dc', ['C', 'X'], ' strong text-red '),
            TextColumn::make('memo'),
        ])
        ->rowClassWhen('dc', 'C', 'row-credit')), []);

    $amount = collect($declared['columns'])->firstWhere('key', 'amount');
    expect($amount['classWhen'])->toBe([
        ['column' => 'dc', 'in' => ['C'], 'class' => 'is-credit'],
        ['column' => 'dc', 'in' => ['C', 'X'], 'class' => 'strong text-red'],
    ])
        ->and(collect($declared['columns'])->firstWhere('key', 'memo'))->not->toHaveKey('classWhen')
        ->and($declared['layout']['rowClassWhen'])->toBe([['column' => 'dc', 'in' => ['C'], 'class' => 'row-credit']]);
});

it('rejects a classWhen on an unknown column, an empty class and the lgrid- prefix', function (Closure $tune, string $message) {
    expect(fn () => classGrid($tune)->assertValid())->toThrow(InvalidArgumentException::class, $message);
})->with([
    'unknown column' => [fn (Grid $g): Grid => $g->rowClassWhen('side', 'C', 'x'), 'rowClassWhen() references unknown column [side]'],
    'empty class' => [fn (Grid $g): Grid => $g->rowClassWhen('dc', 'C', '  '), 'rowClassWhen() declares an empty class'],
    'reserved prefix' => [
        fn (Grid $g): Grid => $g->columns([
            SelectColumn::make('dc')->options(['D' => 'Dr', 'C' => 'Cr']),
            TextColumn::make('memo')->classWhen('dc', 'C', 'ok lgrid-cell--locked'),
        ]),
        'column [memo] classWhen() class [lgrid-cell--locked] uses the reserved lgrid- prefix',
    ],
]);

it('refreshes closure classes in a SET patch only when the verdict changed', function () {
    $grid = classGrid(fn (Grid $g): Grid => $g
        ->rowClass(fn (array $row): ?string => (float) ($row['amount'] ?? 0) > 100 ? 'is-large' : null)
        ->cellClass(fn (mixed $value, array $row, string $key): ?string => $key === 'amount' && (float) $value < 0 ? 'is-negative' : null));
    $rows = [['_k' => 'a', 'dc' => 'D', 'amount' => '10.00', 'memo' => null]];

    $result = (new OpApplier)->apply($grid, $rows, OpBatch::fromPayload(['ops' => [
        ['t' => 'set', 'seq' => 1, 'row' => 'a', 'col' => 'memo', 'v' => 'no class change'],
        ['t' => 'set', 'seq' => 2, 'row' => 'a', 'col' => 'amount', 'v' => '500'],
        ['t' => 'set', 'seq' => 3, 'row' => 'a', 'col' => 'amount', 'v' => '-5'],
        ['t' => 'set', 'seq' => 4, 'row' => 'a', 'col' => 'amount', 'v' => '5'],
    ]]));

    expect($result->results[0]['patch'])->toBe([])
        ->and($result->results[1]['patch'])->toBe(['a' => ['_rowClass' => 'is-large']])
        ->and($result->results[2]['patch'])->toBe(['a' => ['_rowClass' => null, '_cellClass' => ['amount' => 'is-negative']]])
        ->and($result->results[3]['patch'])->toBe(['a' => ['_cellClass' => []]])
        ->and($result->rows[0])->not->toHaveKey('_rowClass')
        ->and($result->rows[0])->not->toHaveKey('_cellClass');
});

it('refreshes closure classes per target row of a fill', function () {
    $grid = classGrid(fn (Grid $g): Grid => $g
        ->rowClass(fn (array $row): ?string => ($row['memo'] ?? null) === 'urgent' ? 'is-urgent' : null));
    $rows = [
        ['_k' => 'a', 'dc' => 'D', 'amount' => '1.00', 'memo' => 'urgent'],
        ['_k' => 'b', 'dc' => 'D', 'amount' => '1.00', 'memo' => 'later'],
        ['_k' => 'c', 'dc' => 'D', 'amount' => '1.00', 'memo' => 'urgent'],
    ];

    $result = (new OpApplier)->apply($grid, $rows, OpBatch::fromPayload(['ops' => [
        ['t' => 'fill', 'seq' => 1, 'col' => 'memo', 'rows' => ['a', 'b', 'c']],
    ]]));

    expect($result->results[0]['patch'])->toBe([
        'b' => ['memo' => 'urgent', '_rowClass' => 'is-urgent'],
        'c' => ['memo' => 'urgent'],
    ]);
});

it('never adds class keys to a patch on a grid without closures', function () {
    $result = (new OpApplier)->apply(
        classGrid(fn (Grid $g): Grid => $g->rowClassWhen('dc', 'C', 'row-credit')),
        [['_k' => 'a', 'dc' => 'D', 'amount' => null, 'memo' => null]],
        OpBatch::fromPayload(['ops' => [
            ['t' => 'set', 'seq' => 1, 'row' => 'a', 'col' => 'dc', 'v' => 'C'],
            ['t' => 'fill', 'seq' => 2, 'col' => 'dc', 'rows' => ['a']],
        ]]),
    );

    expect($result->results[0]['patch'])->toBe([])
        ->and($result->results[1]['patch'])->toBe([]);
});
