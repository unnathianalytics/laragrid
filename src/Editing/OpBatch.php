<?php

declare(strict_types=1);

namespace LaraGrid\Editing;

use InvalidArgumentException;

/**
 * What: A parsed op batch — the client's `baseVersion` plus an ordered list of Ops — built from
 *       the gridOps request payload (plan §2.5.1).
 *
 * Why:  The batch is the unit the OpApplier processes atomically-ish (each op in order, each with
 *       its own ok/errors result). Parsing + shape-validating the whole payload once, at the
 *       boundary, means the applier works with typed Ops and a known-good structure — a malformed
 *       request fails here with a clear message rather than deep inside the applier. `baseVersion`
 *       lets a future conflict check compare the client's assumed version against the server's
 *       (v1 is last-write-wins, G16 — the field is carried now so adding detection needs no wire
 *       change).
 *
 * When: Built by WithLaraGrid::gridOps() from the request; iterated by OpApplier::apply().
 */
final class OpBatch
{
    /**
     * @param  int  $baseVersion  The grid version the client believed current when it batched.
     * @param  list<Op>  $ops  The ops in client order.
     */
    public function __construct(
        public readonly int $baseVersion,
        public readonly array $ops,
    ) {}

    /**
     * Parse a gridOps payload into a typed batch.
     *
     * @param  array<string, mixed>  $payload  {baseVersion?: int, ops: list<array>}
     *
     * @throws InvalidArgumentException On a malformed payload or op.
     */
    public static function fromPayload(array $payload): self
    {
        $rawOps = $payload['ops'] ?? null;
        if (! is_array($rawOps)) {
            throw new InvalidArgumentException('Op batch is missing an ops array.');
        }

        $ops = [];
        foreach (array_values($rawOps) as $raw) {
            if (! is_array($raw)) {
                throw new InvalidArgumentException('Each op must be an object.');
            }
            $ops[] = Op::fromArray($raw);
        }

        $baseVersion = $payload['baseVersion'] ?? 0;

        return new self(
            baseVersion: is_int($baseVersion) ? $baseVersion : (int) $baseVersion,
            ops: $ops,
        );
    }
}
