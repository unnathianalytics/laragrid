<?php

declare(strict_types=1);

use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

/**
 * What: The M5 picker anti-drift lock (JS side) — runs the picker-parse.json vectors through the
 *       REAL datagrid parse.js (date via the shared fuzzy parser, bool, select, editTextFor) via
 *       a Node harness and asserts every case matches.
 *
 * Why:  The picker parse kinds and the editing/interchange text are dual-runtime adjacent (the PHP
 *       cast mirrors live in OpApplier, pinned by OpApplierTest); this locks the CLIENT half —
 *       including the paise→rupee edit text whose absence was the latent M4 F2 defect — so it
 *       can't silently drift. Mirrors the M4 expression-vector harness; skips cleanly where Node
 *       isn't installed (the browser suite exercises the JS live regardless).
 *
 * When: Fast Feature coverage (a single Node process).
 */
it('reproduces every picker parse + editText vector through the real JS modules', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; picker parse vectors are verified in the browser suite instead.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-picker-vectors.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue(
        $process->getOutput().$process->getErrorOutput(),
    );
    expect($process->getOutput())->toContain('picker vectors:');
});
