<?php

declare(strict_types=1);

namespace LaraGrid\Export;

use InvalidArgumentException;
use LaraGrid\Export\Exporters\CsvExporter;
use LaraGrid\Export\Exporters\PdfExporter;
use LaraGrid\Export\Exporters\XlsxExporter;

/**
 * What: The name → Exporter resolver. Ships the dependency-free core writers (csv/xlsx/pdf)
 *       and lets a host app register additional formats or override the shipped ones.
 *
 * Why:  The FormatRegistry pattern applied to exports: `composer require` alone must yield
 *       working CSV/XLSX/PDF downloads (no maatwebsite/dompdf requirement), while an app
 *       with richer needs (Unicode PDF fonts, styled sheets, an ods format) swaps in its
 *       own Exporter under the same name from its provider — Grid definitions never change.
 *       Grid::assertValid validates ->exportable() format names against this registry, so
 *       a typo (or naming a format the app never registered) fails loudly at build time.
 *
 * When: Resolved from the container as a singleton; core exporters register in the
 *       constructor, app exporters in a host service provider.
 */
class ExporterRegistry
{
    /**
     * @var array<string, Exporter>
     */
    protected array $exporters = [];

    public function __construct()
    {
        $this->register('csv', new CsvExporter);
        $this->register('xlsx', new XlsxExporter);
        $this->register('pdf', new PdfExporter);
    }

    /**
     * Register (or override) a named exporter — the extension seam.
     */
    public function register(string $name, Exporter $exporter): void
    {
        $this->exporters[$name] = $exporter;
    }

    public function has(string $name): bool
    {
        return isset($this->exporters[$name]);
    }

    /**
     * @return list<string> The registered format names (build-time validation messages).
     */
    public function names(): array
    {
        return array_keys($this->exporters);
    }

    /**
     * @throws InvalidArgumentException When no exporter is registered under $name.
     */
    public function resolve(string $name): Exporter
    {
        return $this->exporters[$name]
            ?? throw new InvalidArgumentException(
                "No grid exporter registered for [{$name}]; registered: ".implode(', ', $this->names()).'.'
            );
    }
}
