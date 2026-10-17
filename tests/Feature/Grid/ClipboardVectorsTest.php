<?php

declare(strict_types=1);

use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

it('copies the header on select-all and drops it again on paste', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; run `npm test` where it is.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-clipboard-vectors.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue(
        $process->getOutput().$process->getErrorOutput(),
    );
    expect($process->getOutput())->toContain('clipboard vectors OK');
});
