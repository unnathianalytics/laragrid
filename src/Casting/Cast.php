<?php

declare(strict_types=1);

namespace LaraGrid\Casting;

use LaraGrid\Columns\Column;

/**
 * What: The contract for one parse "kind" — turns the raw client-committed value into the
 *       column's model value (e.g. 'decimal' → fixed-scale string, 'bool' → true/false).
 *
 * Why:  Casting is a registry, not a hardcoded match, so a consuming app can add its own
 *       kinds (larafin re-registers 'paise' delegating to its Money support class) without
 *       touching the OpApplier. Every cast MUST have a behaviourally identical JS twin
 *       registered under the same kind (resources/js parse registry) — the optimistic client
 *       value and the authoritative server value must agree (anti-drift rule R2; pin new
 *       pairs with a shared JSON vector).
 *
 * When: Resolved by CastRegistry::cast() inside OpApplier::castValue() for every applied set.
 */
interface Cast
{
    /**
     * @param  array<string, mixed>  $spec  The column's full parseSpec (kind, scale, case, ...).
     */
    public function cast(mixed $value, array $spec, Column $column): mixed;
}
