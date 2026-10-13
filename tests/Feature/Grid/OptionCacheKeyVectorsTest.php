<?php

declare(strict_types=1);

use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

/**
 * What: Runs the picker option cache key vectors (edit/optionCacheKey.js) through the REAL module
 *       via a Node harness and asserts they pass.
 * Why:  The key decides whether a row-dependent picker reuses another row's options; a wrong key
 *       silently shows a list the server would never return for that row. Executing the actual
 *       module is the cheapest durable lock, mirroring the LRU vectors. Skips where Node is absent.
 * When: Runs under the Feature suite; fast (a single Node process).
 */
it('keys the picker option cache by term plus the declared row dependencies', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; the option cache key also runs in host browser tests.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-option-cache-key.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue(
        $process->getOutput().$process->getErrorOutput(),
    );
    expect($process->getOutput())->toContain('Option cache key vectors OK');
});
