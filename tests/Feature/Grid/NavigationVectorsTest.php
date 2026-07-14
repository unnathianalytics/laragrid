<?php

declare(strict_types=1);

use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

/**
 * What: The M2 navigation anti-drift lock — runs the shared tests/fixtures/grid-vectors/
 *       navigation.json cases through the REAL JS geometry + keymap modules (via a Node harness)
 *       and asserts every case matches, so the keyboard engine's movement math can't silently
 *       drift from the committed spec.
 * Why:  Movement (wrap, boundary-escape, skip-gutter, Home/End, Ctrl-edges, paging, both keymaps)
 *       is pure index arithmetic with no PHP counterpart — the vectors ARE the contract, and the
 *       cheapest durable way to hold JS to them is to execute the actual modules over the same
 *       fixture the browser tests use (mirrors how M1 proved formatters.js in Node). Skips
 *       cleanly where Node isn't installed (CI without a JS toolchain), same spirit as the
 *       ext-sockets/Playwright browser prereqs.
 * When: Runs under the Feature suite; fast (a single Node process).
 */
it('resolves every navigation vector through the real geometry + keymap modules', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; JS navigation vectors are verified in the browser suite instead.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-nav-vectors.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue(
        $process->getOutput().$process->getErrorOutput(),
    );
    expect($process->getOutput())->toContain('33/33 passed');
});
