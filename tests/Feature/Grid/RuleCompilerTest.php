<?php

declare(strict_types=1);

use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Validation\RuleCompiler;

/**
 * What: Asserts the RuleCompiler produces the correct server ruleset (authoritative, keeps
 *       everything) and the correct client subset (only single-cell rules the client can honestly
 *       evaluate; closures / cross-field / per-row-required stay server-only).
 *
 * Why:  Validation is dual (plan §2.5/G7): the compiler is the single place the client and server
 *       rule shapes are derived, so the client set can't drift from the server intent. These cases
 *       lock the projection: what the client sees is a strict, safe subset; the server sees all.
 */
it('builds a server ruleset that keeps every declared rule, with required resolved for the row', function () {
    $compiler = new RuleCompiler;

    $required = TextColumn::make('name')->required()->rules(['max:200']);
    expect($compiler->serverRules($required, []))->toBe(['required', 'max:200']);

    $optional = TextColumn::make('narration')->rules(['max:500']);
    expect($compiler->serverRules($optional, []))->toBe(['nullable', 'max:500']);
});

it('resolves a per-row required closure into the server ruleset', function () {
    $compiler = new RuleCompiler;

    $column = DecimalColumn::make('debit')->scale(2)->required(fn (array $row) => ($row['credit'] ?? 0) === 0);

    expect($compiler->serverRules($column, ['credit' => 0]))->toBe(['required'])
        ->and($compiler->serverRules($column, ['credit' => 500]))->toBe(['nullable']);
});

it('projects only single-cell rules into the client subset', function () {
    $compiler = new RuleCompiler;

    $column = IntegerColumn::make('qty')
        ->required()
        ->maxLength(6)
        ->rules(['min:0', 'max:100', 'regex:/^\d+$/']);

    expect($compiler->clientRules($column))->toBe([
        ['rule' => 'required'],
        ['rule' => 'maxLength', 'value' => 6],
        ['rule' => 'min', 'value' => 0.0],
        ['rule' => 'max', 'value' => 100.0],
        ['rule' => 'regex', 'value' => '/^\d+$/'],
    ]);
});

it('expands between into client min and max', function () {
    $compiler = new RuleCompiler;

    $column = IntegerColumn::make('qty')->rules(['between:1,9']);

    expect($compiler->clientRules($column))->toBe([
        ['rule' => 'min', 'value' => 1.0],
        ['rule' => 'max', 'value' => 9.0],
    ]);
});

it('keeps closures, cross-field, and per-row-required rules OUT of the client subset', function () {
    $compiler = new RuleCompiler;

    $closureRequired = TextColumn::make('name')->required(fn () => true);
    expect($compiler->clientRules($closureRequired))->toBe([]);

    $crossField = DecimalColumn::make('debit')->scale(2)->rules(['prohibited_with:credit']);
    expect($compiler->clientRules($crossField))->toBe([]);

    $closureRule = TextColumn::make('name')->rules([fn () => true]);
    expect($compiler->clientRules($closureRule))->toBe([]);
});

it('flags serverOnly when a rule cannot be evaluated client-side', function () {
    $compiler = new RuleCompiler;

    // Purely client-evaluable → not serverOnly.
    expect($compiler->toConfig(TextColumn::make('name')->required()->rules(['max:10'])))
        ->toBe(['client' => [['rule' => 'required'], ['rule' => 'max', 'value' => 10.0]], 'serverOnly' => false]);

    // A cross-field rule → serverOnly true.
    expect($compiler->toConfig(DecimalColumn::make('debit')->scale(2)->rules(['prohibited_with:credit']))['serverOnly'])
        ->toBeTrue();

    // A per-row required closure → serverOnly true.
    expect($compiler->toConfig(TextColumn::make('name')->required(fn () => true))['serverOnly'])
        ->toBeTrue();
});
