<?php

declare(strict_types=1);

namespace LaraGrid\Editing;

use InvalidArgumentException;

/**
 * What: One typed edit operation from the client's op batch — a set (cell edit), insert
 *       (new blank row), remove (delete row), dup (duplicate row), or fill (Ctrl+D fill-down).
 *       An immutable value object parsed from the wire shape (plan §2.5.1).
 *
 * Why:  The op protocol is the ONLY write channel (plan §2.5): every edit crosses as one of these.
 *       Modelling an op as a typed object — parsed and shape-validated once at the boundary — means
 *       the OpApplier switches on a known kind and reads named fields, never sniffs a loose array.
 *       Every op carries a client `seq` (monotonic) so the client can reconcile out-of-order
 *       responses and skip cells it has since re-edited, and a stable row `_k` so an op never
 *       references a shifting index (G1).
 *
 * When: Built by OpBatch::fromPayload() from the gridOps request; consumed by OpApplier::apply().
 */
final class Op
{
    public const SET = 'set';

    public const INSERT = 'insert';

    public const REMOVE = 'remove';

    public const DUP = 'dup';

    public const FILL = 'fill';

    private const KINDS = [self::SET, self::INSERT, self::REMOVE, self::DUP, self::FILL];

    /**
     * @param  int  $seq  The client's monotonic sequence number for this op.
     * @param  string  $kind  One of the KINDS constants.
     * @param  string|null  $row  The target row `_k` (set/remove/dup/fill).
     * @param  string|null  $after  The row `_k` to insert after (insert; null = append at end).
     * @param  string|null  $as  The new row's `_k` for insert/dup (client-generated).
     * @param  string|null  $col  The target column key (set/fill).
     * @param  mixed  $value  The raw typed-text value (set/fill), parsed/cast by the applier.
     * @param  list<string>|null  $rows  The row `_k`s a fill spans (fill), in order.
     * @param  string|null  $label  The picked option's display label (set on picker columns, M5) —
     *                              display-only, stored in the row's `_labels` bag, never persisted.
     */
    public function __construct(
        public readonly int $seq,
        public readonly string $kind,
        public readonly ?string $row = null,
        public readonly ?string $after = null,
        public readonly ?string $as = null,
        public readonly ?string $col = null,
        public readonly mixed $value = null,
        public readonly ?array $rows = null,
        public readonly ?string $label = null,
    ) {}

    /**
     * Parse and shape-validate one op from its wire array. Rejects an unknown kind or a kind
     * missing its required fields with a clear message (never a fatal on a malformed payload).
     *
     * @param  array<string, mixed>  $data
     *
     * @throws InvalidArgumentException On a malformed op.
     */
    public static function fromArray(array $data): self
    {
        $kind = $data['t'] ?? null;
        if (! is_string($kind) || ! in_array($kind, self::KINDS, true)) {
            throw new InvalidArgumentException('Op has an unknown or missing type ['.json_encode($kind).'].');
        }

        $seq = $data['seq'] ?? null;
        if (! is_int($seq)) {
            throw new InvalidArgumentException("Op [{$kind}] is missing an integer seq.");
        }

        $op = new self(
            seq: $seq,
            kind: $kind,
            row: isset($data['row']) ? (string) $data['row'] : null,
            after: isset($data['after']) ? (string) $data['after'] : null,
            as: isset($data['as']) ? (string) $data['as'] : null,
            col: isset($data['col']) ? (string) $data['col'] : null,
            value: $data['v'] ?? null,
            rows: isset($data['rows']) && is_array($data['rows'])
                ? array_map('strval', array_values($data['rows']))
                : null,
            label: isset($data['label']) ? (string) $data['label'] : null,
        );

        $op->assertShape();

        return $op;
    }

    /**
     * Enforce the per-kind required fields.
     *
     * @throws InvalidArgumentException
     */
    private function assertShape(): void
    {
        switch ($this->kind) {
            case self::SET:
                if ($this->row === null || $this->col === null) {
                    throw new InvalidArgumentException('A set op requires row and col.');
                }
                break;
            case self::INSERT:
                if ($this->as === null) {
                    throw new InvalidArgumentException('An insert op requires the new row key (as).');
                }
                break;
            case self::REMOVE:
                if ($this->row === null) {
                    throw new InvalidArgumentException('A remove op requires row.');
                }
                break;
            case self::DUP:
                if ($this->row === null || $this->as === null) {
                    throw new InvalidArgumentException('A dup op requires row and the new row key (as).');
                }
                break;
            case self::FILL:
                if ($this->col === null || $this->rows === null || $this->rows === []) {
                    throw new InvalidArgumentException('A fill op requires col and a non-empty rows list.');
                }
                break;
        }
    }
}
