<?php

declare(strict_types=1);

use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;

/**
 * What: The M4 expression anti-drift lock (JS side) — runs the shared expressions.json vectors
 *       through the REAL datagrid ExprEval + parse modules (via a Node harness) and asserts every
 *       case matches, so the client evaluator/parsers can't silently drift from the PHP engine.
 * Why:  The expression evaluator + the value parsers are the dual-runtime pieces (plan R2). The PHP
 *       side is locked by ExpressionEngineTest against the same fixture; this runs the actual JS
 *       modules over that fixture (the AST was produced by the sole PHP parser), so PHP↔JS equality
 *       holds by construction. Mirrors the M2 navigation-vector harness; skips cleanly where Node
 *       isn't installed (the browser suite exercises the JS live regardless).
 * When: Fast Feature coverage (a single Node process).
 */
it('reproduces every expression vector + parse cast through the real JS modules', function () {
    $node = (new ExecutableFinder)->find('node');

    if ($node === null) {
        $this->markTestSkipped('Node is not available; JS expression/parse vectors are verified in the browser suite instead.');
    }

    $process = new Process([$node, dirname(__DIR__, 3).'/tests/js/run-expression-vectors.mjs'], dirname(__DIR__, 3));
    $process->run();

    expect($process->isSuccessful())->toBeTrue(
        $process->getOutput().$process->getErrorOutput(),
    );
    expect($process->getOutput())->toContain('passed; parse:');
});
