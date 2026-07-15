<?php

declare(strict_types=1);

use LaraGrid\Casting\CastRegistry;
use LaraGrid\Columns\CheckboxColumn;
use LaraGrid\Columns\YesNoColumn;

/**
 * What: The PHP half of the boolean-cast anti-drift pair — runs the SAME picker-parse.json `bool`
 *       and `yn` vectors the JS harness pins (run-picker-vectors.mjs → parseBool/parseYn) through
 *       the real CastRegistry casts (BoolCast/YnCast).
 *
 * Why:  The parse kinds are dual-runtime: the client applies the optimistic value, the server cast
 *       is authoritative, and the two must agree by construction (plan R2) or reconciled cells
 *       flicker. One fixture feeding both runtimes is what makes drift impossible to miss.
 *
 * When: Fast Feature coverage (pure in-process, no Node).
 */
it('reproduces every bool and yn vector through the PHP casts', function () {
    $vectors = json_decode(
        file_get_contents(dirname(__DIR__, 2).'/fixtures/grid-vectors/picker-parse.json'),
        true,
    );

    $registry = new CastRegistry;
    $checkbox = CheckboxColumn::make('flag');
    $yesno = YesNoColumn::make('answer');

    foreach ($vectors['bool'] as $vector) {
        expect($registry->cast('bool', $vector['raw'], ['kind' => 'bool'], $checkbox))
            ->toBe($vector['expected'], 'bool '.json_encode($vector['raw']));
    }

    foreach ($vectors['yn'] as $vector) {
        expect($registry->cast('yn', $vector['raw'], ['kind' => 'yn'], $yesno))
            ->toBe($vector['expected'], 'yn '.json_encode($vector['raw']));
    }
});

it('serializes YesNoColumn with the yesno painter/editor and the yn parse kind', function () {
    $config = YesNoColumn::make('taxable')->toArray();

    expect($config['type'])->toBe('yesno');
    expect($config['painter'])->toBe('yesno');
    expect($config['editor'])->toBe('yesno');
    expect($config['parse'])->toBe(['kind' => 'yn']);
    expect($config['editable'])->toBeTrue();
    expect($config['align'])->toBe('center');
    expect(YesNoColumn::make('taxable')->implicitRules())->toBe(['boolean']);
});
