<?php

declare(strict_types=1);

use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

/**
 * What: Runs the PageSource cache (util/lru.js) eviction/recency vectors through the REAL module
 *       via a Node harness and asserts they pass.
 * Why:  The LRU eviction order is load-bearing for the M3 page cache (a wrong eviction silently
 *       drops the wrong cached page); executing the actual module is the cheapest durable lock,
 *       mirroring the M2 navigation-vectors approach. Skips cleanly where Node isn't installed.
 * When: Runs under the Feature suite; fast (a single Node process).
 */
it('holds the LRU cache eviction/recency contract through the real module', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; the LRU cache is also exercised by the pagination browser test.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-lru-vectors.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue(
        $process->getOutput().$process->getErrorOutput(),
    );
    expect($process->getOutput())->toContain('LRU vectors OK');
});
