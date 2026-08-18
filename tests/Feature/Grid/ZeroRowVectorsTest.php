<?php

declare(strict_types=1);

use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

it('keeps the editable auto-append surface usable through delete undo and redo', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; run `npm test` where it is.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-zero-row-vectors.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue(
        $process->getOutput().$process->getErrorOutput(),
    );
    expect($process->getOutput())->toContain('zero-row vectors OK');
});
