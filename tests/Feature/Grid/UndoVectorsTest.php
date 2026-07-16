<?php

declare(strict_types=1);

use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

/**
 * What: Runs the undo/redo scenarios through the REAL StateStore + UndoManager modules via the
 *       Node harness (tests/js/run-undo-vectors.mjs) and asserts they pass.
 * Why:  Undo replays inverses through the op pipeline — a drift between the recorder seam and
 *       the replay engine would silently corrupt operator data on Ctrl+Z. Executing the actual
 *       modules is the cheapest durable lock, mirroring the navigation/LRU vector approach.
 * When: Runs under the Feature suite; fast (a single Node process).
 */
it('holds the undo/redo record-replay contract through the real modules', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; run `npm test` where it is.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-undo-vectors.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue(
        $process->getOutput().$process->getErrorOutput(),
    );
    expect($process->getOutput())->toContain('undo vectors OK');
});
