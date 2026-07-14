<?php

declare(strict_types=1);

namespace LaraGrid\Columns\Concerns;

/**
 * What: The embedded-options fluent surface shared by the picker columns — ->options() accepting
 *       an assoc map (value => label), a list of {value, label(, meta)} arrays, or a list of
 *       scalars (value === label), normalised once to a canonical list<{value, label}>.
 *
 * Why:  Options crossing to the client must have ONE shape whatever the author passed, so the
 *       select painter/editor and the implicit in: validation read the same canonical list.
 *       Embedded options ship to every viewer of the grid, so they are for SMALL, NON-SENSITIVE,
 *       tenant-invariant sets only (UoM, voucher types); anything queried/tenant-scoped must use
 *       SearchSelectColumn::optionsUsing() instead — the same client/server rule the form-kit
 *       combobox established.
 *
 * When: Mixed into SelectColumn (embedded is its only mode) and SearchSelectColumn (its optional
 *       small-set client mode).
 */
trait HasOptions
{
    /**
     * Canonical embedded options.
     *
     * @var list<array{value: string, label: string}>
     */
    protected array $options = [];

    /**
     * Declare the embedded options.
     *
     * @param  array<int|string, mixed>  $options  value => label map, list of {value, label}
     *                                             arrays, or list of scalar values.
     */
    public function options(array $options): static
    {
        $this->options = $this->normalizeOptions($options);

        return $this;
    }

    /**
     * The canonical embedded options.
     *
     * @return list<array{value: string, label: string}>
     */
    public function getOptions(): array
    {
        return $this->options;
    }

    /**
     * The embedded option VALUES — the whitelist the implicit in: rule validates against.
     *
     * @return list<string>
     */
    public function optionValues(): array
    {
        return array_column($this->options, 'value');
    }

    /**
     * Normalise any accepted author shape to the canonical list.
     *
     * @param  array<int|string, mixed>  $options
     * @return list<array{value: string, label: string}>
     */
    protected function normalizeOptions(array $options): array
    {
        $normalized = [];

        foreach ($options as $key => $option) {
            if (is_array($option)) {
                // {value, label} entry (label falls back to the value).
                $value = (string) ($option['value'] ?? '');
                $label = (string) ($option['label'] ?? $value);
            } elseif (is_string($key)) {
                // Assoc map: value => label.
                $value = $key;
                $label = (string) $option;
            } else {
                // Scalar list: value === label.
                $value = (string) $option;
                $label = (string) $option;
            }

            $normalized[] = ['value' => $value, 'label' => $label];
        }

        return $normalized;
    }
}
