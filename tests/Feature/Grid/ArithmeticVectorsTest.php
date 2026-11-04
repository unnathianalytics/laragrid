<?php

declare(strict_types=1);

use LaraGrid\Casting\Arithmetic;
use LaraGrid\Casting\CastRegistry;
use LaraGrid\Columns\DecimalColumn;
use LaraGrid\Columns\IntegerColumn;
use LaraGrid\Tests\Hosts\VoucherLinesGridComponent;
use Livewire\Livewire;
use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

/**
 * What: The calculator-entry anti-drift pair (plan F1). The PHP half runs every
 *       arithmetic.json vector through the real CastRegistry int and decimal casts; the JS half
 *       runs the same file through parse.js (run-arithmetic-vectors.mjs, skipped without Node).
 *       A gridOps round trip proves the server stores the evaluated value and recomputes the
 *       dependent formula from it.
 *
 * Why:  Number cells send the operator's raw text; the client value is optimistic and the
 *       server cast is authoritative. If the two evaluated `1250*12` differently, every
 *       calculator entry would flicker on reconcile.
 *
 * When: Fast Feature coverage.
 */
function arithmeticVectors(): array
{
    return json_decode(
        file_get_contents(dirname(__DIR__, 2).'/fixtures/grid-vectors/arithmetic.json'),
        true,
    );
}

afterEach(fn () => VoucherLinesGridComponent::resetTuning());

it('reproduces every arithmetic vector through the PHP int and decimal casts', function () {
    $vectors = arithmeticVectors();
    $registry = new CastRegistry;

    foreach ($vectors['cases'] as $vector) {
        $decimal = DecimalColumn::make('rate')->scale($vector['scale']);

        expect($registry->cast('int', $vector['raw'], ['kind' => 'int'], IntegerColumn::make('qty')))
            ->toBe($vector['int'], 'int '.json_encode($vector['raw']));
        expect($registry->cast('decimal', $vector['raw'], $decimal->parseSpec(), $decimal))
            ->toBe($vector['decimal'], 'decimal '.json_encode($vector['raw']));
    }
});

it('casts a malformed expression to zero on the server', function () {
    $registry = new CastRegistry;

    foreach (arithmeticVectors()['malformed'] as $vector) {
        $decimal = DecimalColumn::make('rate')->scale($vector['scale']);

        expect($registry->cast('int', $vector['raw'], ['kind' => 'int'], IntegerColumn::make('qty')))
            ->toBe(0, 'int '.json_encode($vector['raw']));
        expect($registry->cast('decimal', $vector['raw'], $decimal->parseSpec(), $decimal))
            ->toBe(number_format(0, $vector['scale'], '.', ''), 'decimal '.json_encode($vector['raw']));
    }
});

it('leaves non-string values and plain numbers to the plain number path', function () {
    expect(Arithmetic::evaluate(15000))->toBeNull()
        ->and(Arithmetic::evaluate(12.5))->toBeNull()
        ->and(Arithmetic::evaluate(null))->toBeNull()
        ->and(Arithmetic::evaluate('-5'))->toBeNull()
        ->and(Arithmetic::evaluate('12,345'))->toBeNull()
        ->and(Arithmetic::evaluate('abc'))->toBeNull()
        ->and(Arithmetic::evaluate('1250*12'))->toBe(15000.0)
        ->and(fn () => Arithmetic::evaluate('1+'))->toThrow(InvalidArgumentException::class);
});

it('stores the evaluated value of a calculator entry and recomputes the formula from it', function () {
    $component = Livewire::test(VoucherLinesGridComponent::class);
    $key = $component->get('lines')[0]['_k'];

    $response = $component->call('gridOps', 'lines', [
        'baseVersion' => 0,
        'ops' => [
            ['t' => 'set', 'seq' => 1, 'row' => $key, 'col' => 'qty', 'v' => '2*3'],
            ['t' => 'set', 'seq' => 2, 'row' => $key, 'col' => 'rate', 'v' => '1,250*12'],
        ],
    ])->effects['returns'][0];

    $line = $component->get('lines')[0];

    expect($line['qty'])->toBe(6)
        ->and($line['rate'])->toBe('15000.00')
        ->and((float) $line['amount'])->toBe(90000.0)
        ->and($response['results'][1]['ok'])->toBeTrue()
        ->and((float) $response['results'][1]['patch'][$key]['amount'])->toBe(90000.0);
});

it('reproduces every arithmetic vector through the real JS casts', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; the JS arithmetic vectors run in npm test instead.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-arithmetic-vectors.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue($process->getOutput().$process->getErrorOutput())
        ->and($process->getOutput())->toContain('passed');
});
