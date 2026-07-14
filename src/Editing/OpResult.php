<?php

declare(strict_types=1);

namespace LaraGrid\Editing;

/**
 * What: The outcome of applying an op batch — the new grid `version`, a per-op `results` list
 *       (each carrying its authoritative write-back `patch` and any `errors`), the recomputed
 *       `footer` totals, the applied `rows` (for the host to write back to its prop), and a
 *       `refreshHost` flag telling the trait whether to re-render host chrome (plan §2.5.1 / G6).
 *
 * Why:  One typed object carries everything the client reconciles and the host needs: the client
 *       reads version/results/footer (skipping cells it has since re-edited by seq); the host's
 *       gridOps writes rows back to its bound property; the trait consults refreshHost to decide
 *       render vs. renderless. Keeping `rows` off the wire (toArray() omits it) means the applied
 *       rows never bloat the RPC response — they live in the host snapshot, which already carries
 *       them (plan R1).
 *
 * When: Produced by OpApplier::apply(); its toArray() is the gridOps JSON response.
 */
final class OpResult
{
    /**
     * @param  int  $version  The grid version after this batch.
     * @param  list<array{seq: int, ok: bool, patch: array<string, array<string, mixed>>, errors: array<string, array<string, string>>}>  $results
     * @param  array<string, int|float|string>  $footer  Recomputed footer aggregate values by column.
     * @param  list<array<string, mixed>>  $rows  The applied rows (host writes back; NOT serialized to the wire).
     * @param  bool  $refreshHost  Whether any op touched a refreshesHost column (drop Renderless).
     */
    public function __construct(
        public readonly int $version,
        public readonly array $results,
        public readonly array $footer,
        public readonly array $rows,
        public readonly bool $refreshHost,
    ) {}

    /**
     * The wire response for gridOps — version + per-op results + footer. Deliberately omits `rows`
     * (they ride the host snapshot) and `refreshHost` (a trait-side render decision, not client data).
     *
     * @return array{version: int, results: list<array<string, mixed>>, footer: array<string, int|float|string>}
     */
    public function toArray(): array
    {
        return [
            'version' => $this->version,
            'results' => $this->results,
            'footer' => $this->footer,
        ];
    }
}
