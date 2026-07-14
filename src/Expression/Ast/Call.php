<?php

declare(strict_types=1);

namespace LaraGrid\Expression\Ast;

/**
 * What: A function-call node: round/min/max/abs/ceil/floor/if applied to argument sub-trees.
 *
 * Why:  The grid's numeric needs are covered by a small, fixed function set (rounding at a scale,
 *       clamping, conditional selection). Keeping the set closed — resolved by name in both
 *       evaluators — means no arbitrary code, CSP-safe, and identical PHP/JS behaviour pinned by
 *       vectors (plan §2.7: "one parser, two dumb evaluators").
 *
 * When: Emitted by the Parser when an identifier is followed by '('.
 */
final class Call extends Node
{
    /**
     * @param  list<Node>  $args
     */
    public function __construct(
        public readonly string $fn,
        public readonly array $args,
    ) {}

    /**
     * @return array{t: string, fn: string, args: list<array<string, mixed>>}
     */
    public function toArray(): array
    {
        return [
            't' => 'call',
            'fn' => $this->fn,
            'args' => array_map(fn (Node $a): array => $a->toArray(), $this->args),
        ];
    }
}
