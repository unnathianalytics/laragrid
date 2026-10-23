<?php

declare(strict_types=1);

use Illuminate\Contracts\Validation\ValidationRule;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\ValidationException;
use LaraGrid\Columns\Column;
use LaraGrid\Columns\DateColumn;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\SelectColumn;
use LaraGrid\Columns\SerialColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Support\RowSerializer;
use LaraGrid\Tests\Hosts\RuleMatrixGridComponent;
use LaraGrid\Tests\Hosts\WideEditableGridComponent;
use LaraGrid\Validation\RuleCompiler;

/**
 * What: The save-path validation contract after perf plan P5. gridRows() and the
 *       draft-restore final pass validate each row with one shared Validator for its
 *       self-contained columns, and a Validator of their own for any column whose rules could
 *       see or change a sibling's outcome (exclude*, closures, rule objects).
 * Why:  Consumers (larafin's voucher, quotation, POS and master grids) rely on the exact
 *       messages and keys the old one-Validator-per-cell loop produced. These tests compare the
 *       new path against that loop, verbatim, over a rule matrix that includes the cases a
 *       naive shared Validator gets wrong.
 */

/**
 * The pre-P5 reference: one Validator per editable cell, reading only that cell's key.
 *
 * @param  list<array<string, mixed>>  $rows  clean rows (as gridRows() validates them)
 * @return array<string, list<string>>
 */
function perCellReference(Grid $grid, array $rows): array
{
    $compiler = new RuleCompiler;
    $messages = [];
    foreach ($rows as $index => $row) {
        foreach ($grid->getColumns() as $column) {
            if (! $column->isEditable()) {
                continue;
            }
            $validator = Validator::make($row, [$column->key => $compiler->serverRules($column, $row)]);
            foreach ($validator->errors()->get($column->key) as $message) {
                $messages["{$grid->name}.{$index}.{$column->key}"][] = (string) $message;
            }
        }
    }

    return $messages;
}

/**
 * Run gridRows() on a matrix host and return its messages ([] when it passes).
 *
 * @param  list<Column>  $columns
 * @param  list<array<string, mixed>>  $rows
 * @return array{0: array<string, list<string>>, 1: array<string, list<string>>} [actual, reference]
 */
function gridRowsVersusReference(array $columns, array $rows): array
{
    $host = (new RuleMatrixGridComponent)->useColumns($columns);
    $host->lines = $rows;
    $grid = $host->gridDefinition('lines');

    try {
        $host->gridRows('lines');
        $actual = [];
    } catch (ValidationException $e) {
        $actual = $e->errors();
    }

    $clean = app(RowSerializer::class)->cleanEditableRows($grid, $rows);

    return [$actual, perCellReference($grid, $clean)];
}

/** A rule object that always fails and reads the validator (the class larafin's ExistsInTenantBatch belongs to). */
function alwaysFailingRule(): ValidationRule
{
    return new class implements ValidationRule
    {
        public function validate(string $attribute, mixed $value, Closure $fail): void
        {
            if ($value !== null && $value !== '') {
                $fail('The :attribute is rejected by the rule object.');
            }
        }
    };
}

it('reports exactly the per-cell messages for the voucher-style rule set', function () {
    $columns = [
        SerialColumn::make(),
        SelectColumn::make('kind')->options(['goods' => 'Goods', 'service' => 'Service'])->required(),
        TextColumn::make('narration')->maxLength(10)->required(),
        DecimalColumn::make('qty')->scale(3)->rules(['numeric', 'gt:0'])->required(fn (array $row): bool => ($row['kind'] ?? null) === 'goods'),
        DecimalColumn::make('rate')->scale(2)->rules(['numeric', 'min:0']),
        DecimalColumn::make('disc')->scale(2)->rules(['numeric', 'min:0', 'max:100']),
        DecimalColumn::make('ret')->scale(2)->rules(['numeric', 'not_in:0']),
        DateColumn::make('due'),
        TextColumn::make('serial')->rules([
            'string',
            'max:255',
            function (string $attribute, mixed $value, Closure $fail): void {
                if ($value === 'SOLD') {
                    $fail('The selected serial number is no longer eligible.');
                }
            },
        ]),
    ];
    $rows = [
        ['_k' => 'a', 'kind' => 'goods', 'narration' => 'ok', 'qty' => '2', 'rate' => '10', 'disc' => '5', 'ret' => '1', 'due' => '2026-10-01', 'serial' => 'S1'],
        ['_k' => 'b', 'kind' => 'goods', 'narration' => 'far too long text', 'qty' => '0', 'rate' => '-1', 'disc' => '101', 'ret' => '0', 'due' => '01-10-2026', 'serial' => 'SOLD'],
        ['_k' => 'c', 'kind' => 'nope', 'narration' => '', 'qty' => null, 'rate' => 'abc', 'disc' => null, 'ret' => null, 'due' => null, 'serial' => null],
        ['_k' => 'd', 'kind' => 'service', 'narration' => 'svc', 'qty' => null, 'rate' => '5', 'disc' => null, 'ret' => '-3', 'due' => null, 'serial' => null],
    ];

    [$actual, $reference] = gridRowsVersusReference($columns, $rows);

    expect($reference)->not->toBe([])           // the matrix really exercises failures
        ->and($actual)->toBe($reference);       // same keys, same order, same messages
});

it('matches per-cell results when exclude rules and their referenced siblings share a row', function () {
    $columns = [
        TextColumn::make('flag'),
        TextColumn::make('a')->rules(['exclude_if:flag,1']),
        TextColumn::make('b')->rules(['required_with:a']),
    ];
    $rows = [
        ['_k' => 'x', 'flag' => '1', 'a' => 'present', 'b' => ''],
        ['_k' => 'y', 'flag' => '0', 'a' => 'present', 'b' => ''],
    ];

    [$actual, $reference] = gridRowsVersusReference($columns, $rows);

    expect($reference)->toHaveKeys(['lines.0.b', 'lines.1.b'])
        ->and($actual)->toBe($reference);
});

it('keeps an exclude rule from skipping a nested sibling key the way a shared validator would', function () {
    $columns = [
        TextColumn::make('flag'),
        TextColumn::make('meta')->rules(['exclude_if:flag,1']),
        TextColumn::make('meta.note')->required(),
    ];
    $rows = [['_k' => 'x', 'flag' => '1', 'meta' => ['note' => '']]];

    // The trap: in ONE validator an excluded `meta` also excludes every `meta.*` key, so the
    // required meta.note is never checked. The old per-cell loop DID report it.
    $naive = Validator::make($rows[0], ['meta' => ['nullable', 'exclude_if:flag,1'], 'meta.note' => ['required']]);
    expect($naive->errors()->has('meta.note'))->toBeFalse();

    [$actual, $reference] = gridRowsVersusReference($columns, $rows);

    expect($reference)->toHaveKey('lines.0.meta.note')
        ->and($actual)->toBe($reference);
});

it('keeps a closure that fails under another column key from leaking into that column', function () {
    $crossKey = function (string $attribute, mixed $value, Closure $fail): void {
        $fail('rate', 'Cross-column message.');
    };
    $columns = [
        TextColumn::make('rate')->rules(['numeric']),
        TextColumn::make('qty')->rules([$crossKey]),
        TextColumn::make('note')->rules(['max:3']),
    ];
    $rows = [['_k' => 'x', 'rate' => '1', 'qty' => '2', 'note' => 'long']];

    // The trap: in ONE validator the closure's message lands on `rate`, a column that passed.
    $naive = Validator::make($rows[0], ['rate' => ['nullable', 'numeric'], 'qty' => ['nullable', $crossKey]]);
    expect($naive->errors()->get('rate'))->toBe(['Cross-column message.']);

    [$actual, $reference] = gridRowsVersusReference($columns, $rows);

    expect($actual)->toBe($reference)
        ->and($actual)->toHaveKey('lines.0.note')
        ->and($actual)->not->toHaveKey('lines.0.rate');
});

it('validates rule objects in isolation with unchanged messages', function () {
    $columns = [
        TextColumn::make('code')->rules([alwaysFailingRule()]),
        TextColumn::make('name')->required()->maxLength(4),
    ];
    $rows = [
        ['_k' => 'x', 'code' => 'Z9', 'name' => 'toolong'],
        ['_k' => 'y', 'code' => null, 'name' => 'ok'],
    ];

    [$actual, $reference] = gridRowsVersusReference($columns, $rows);

    expect($actual)->toHaveKeys(['lines.0.code', 'lines.0.name'])
        ->and($actual)->toBe($reference);
});

it('passes a clean grid exactly as before', function () {
    $columns = [
        TextColumn::make('name')->required()->maxLength(10),
        DecimalColumn::make('qty')->rules(['numeric', 'gt:0']),
    ];
    $rows = [['_k' => 'x', 'name' => 'Bolt', 'qty' => '3']];

    [$actual, $reference] = gridRowsVersusReference($columns, $rows);

    expect($actual)->toBe([])->and($reference)->toBe([]);
});

it('builds at most one Validator per row for self-contained rules', function () {
    $built = 0;
    Validator::resolver(function ($translator, $data, $rules, $messages, $attributes) use (&$built) {
        $built++;

        return new Illuminate\Validation\Validator($translator, $data, $rules, $messages, $attributes);
    });

    $columns = array_map(
        fn (int $i): TextColumn => TextColumn::make('c'.$i)->required()->rules(['string'])->maxLength(20),
        range(1, 10),
    );
    $rows = [];
    for ($r = 0; $r < 200; $r++) {
        $row = ['_k' => 'r'.$r];
        foreach (range(1, 10) as $i) {
            $row['c'.$i] = 'v'.$r;
        }
        $rows[] = $row;
    }

    $host = (new RuleMatrixGridComponent)->useColumns($columns);
    $host->lines = $rows;

    expect($host->gridRows('lines'))->toHaveCount(200)
        ->and($built)->toBe(200); // was 2,000 (one per cell)
});

it('builds no Validator for a row whose columns are all nullable', function () {
    $built = 0;
    Validator::resolver(function ($translator, $data, $rules, $messages, $attributes) use (&$built) {
        $built++;

        return new Illuminate\Validation\Validator($translator, $data, $rules, $messages, $attributes);
    });

    $host = new WideEditableGridComponent;
    $host->rows = [['_k' => 'r1', 'c1' => 'filled'], ['_k' => 'r2', 'c3' => 'also']];

    expect($host->gridRows('wide'))->toHaveCount(2)
        ->and($built)->toBe(0);
});
