<?php

declare(strict_types=1);

use LaraGrid\Formatting\Formatter;
use LaraGrid\Formatting\FormatRegistry;

/**
 * What: Asserts the PHP FormatRegistry renders every shared vector to its committed
 *       `expected` string — including the inr/qty vectors, satisfied by REFERENCE
 *       implementations registered through the public seam (the same way a consuming
 *       accounting app registers its own).
 *
 * Why:  Formatting is the one layer implemented in both PHP and JS (anti-drift rule R2).
 *       These vectors are the contract: this test locks the PHP side, the node runners lock
 *       the JS port over the same file. The reference inr/qty registrations here mirror
 *       the kind an app would register, so the extension seam itself stays vector-proven
 *       even though those formatters left the core.
 */
function laragridRegisterReferenceFormats(FormatRegistry $registry): void
{
    $groupIndian = function (string $digits): string {
        if (strlen($digits) <= 3) {
            return $digits;
        }
        $last3 = substr($digits, -3);
        $rest = substr($digits, 0, -3);

        return preg_replace('/\B(?=(\d{2})+(?!\d))/', ',', $rest).','.$last3;
    };

    $registry->register('inr', new class($groupIndian) implements Formatter
    {
        public function __construct(private readonly Closure $group) {}

        public function format(mixed $value, array $args = []): string
        {
            if ($value === null || $value === '') {
                return '';
            }
            $paise = (int) $value;
            $negative = $paise < 0;
            $abs = abs($paise);

            return ($negative ? '-' : '')
                .($this->group)((string) intdiv($abs, 100))
                .'.'.str_pad((string) ($abs % 100), 2, '0', STR_PAD_LEFT);
        }
    });

    $registry->register('qty', new class($groupIndian) implements Formatter
    {
        public function __construct(private readonly Closure $group) {}

        public function format(mixed $value, array $args = []): string
        {
            if ($value === null || $value === '') {
                return '';
            }
            $scale = max(0, (int) ($args['scale'] ?? 3));
            $fixed = number_format(round((float) $value, $scale, PHP_ROUND_HALF_UP), $scale, '.', '');
            $negative = str_starts_with($fixed, '-');
            $abs = $negative ? substr($fixed, 1) : $fixed;
            [$int, $frac] = $scale > 0 ? explode('.', $abs) : [$abs, ''];

            return ($negative ? '-' : '').($this->group)($int).($scale > 0 ? '.'.$frac : '');
        }
    });
}

it('renders every shared format vector to its expected string (PHP side)', function () {
    $registry = app(FormatRegistry::class);
    laragridRegisterReferenceFormats($registry);

    $path = dirname(__DIR__, 3).'/tests/fixtures/grid-vectors/formats.json';
    expect(file_exists($path))->toBeTrue();

    /** @var array{vectors: list<array{name: string, args: array<string, scalar>, input: mixed, expected: string}>} $data */
    $data = json_decode((string) file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);

    expect($data['vectors'])->not->toBeEmpty();

    foreach ($data['vectors'] as $i => $vector) {
        $actual = $registry->format($vector['name'], $vector['input'], $vector['args']);

        expect($actual)->toBe(
            $vector['expected'],
            sprintf(
                'Vector #%d [%s(%s)] over input %s expected "%s" but got "%s".',
                $i,
                $vector['name'],
                json_encode($vector['args']),
                json_encode($vector['input']),
                $vector['expected'],
                $actual,
            ),
        );
    }
});

it('ships ONLY the neutral core formatters — inr/qty are app-registered (extraction guarantee)', function () {
    $registry = app(FormatRegistry::class);

    expect($registry->has('text'))->toBeTrue()
        ->and($registry->has('number'))->toBeTrue()
        ->and($registry->has('date'))->toBeTrue()
        ->and($registry->has('inr'))->toBeFalse()
        ->and($registry->has('qty'))->toBeFalse();
});
