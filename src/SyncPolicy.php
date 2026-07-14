<?php

declare(strict_types=1);

namespace LaraGrid;

/**
 * What: When a client-side edit's op is flushed to the server for an editable grid.
 *
 * Why:  Every edit applies to the client StateStore optimistically and paints instantly
 *       (plan §2.1: "JS owns motion"); this enum only decides WHEN the resulting op leaves
 *       the client for the authoritative OpApplier (plan §1.3 G5, §2.4 SyncManager). All three
 *       policies use the same op queue and the same op protocol — the policy changes flush
 *       timing, nothing else — so a grid can trade round-trip chattiness for latency-of-truth
 *       without any other code path changing. Modelled as an enum (not a string) so the
 *       serialized config is closed to a set the client SyncManager has a branch for, and a
 *       typo fails at the type boundary rather than silently disabling sync.
 *
 * When: Set on a Grid via ->sync(SyncPolicy::…) and serialized into config.layout.sync; the
 *       client SyncManager reads it to choose its flush trigger.
 */
enum SyncPolicy: string
{
    /** Flush the queued op on every cell commit — the default (freshest server truth). */
    case PerCell = 'per-cell';

    /** Flush when the active row changes — one round-trip per completed row. */
    case PerRow = 'per-row';

    /** Never flush mid-entry; the host calls the grid's flush() before save/action only. */
    case Deferred = 'deferred';
}
