# LaraGrid — Package Extraction Plan (v1)

Source: the working UF-DataGrid in `D:\herd\larafin` (`app/Grid/**`, `resources/js/datagrid/**`,
`resources/css/datagrid.css`, `resources/views/components/uf/datagrid.blade.php`).
Design authority: larafin `docs/plans/2026-07-02-0624-custom-grid-component.md` (guardrails G1–G20,
portability §3.11) and `docs/datagrid-migration-guide.md`.

---

## Goal

A standalone Composer package delivering the datagrid engine (display, readonly server-side,
editable modes) with:

- Zero consumer build tooling — `composer require`, drop one Blade tag, done. No npm, no Vite config.
- Zero blade configuration — every behavior controlled from the component class via chained methods.
- Package-rendered toolbar (search / filters / per-page / actions / column chooser).
- Fully customizable: column types, editors, painters, formatters, casts, select sources, theming.
- Compatibility: Laravel ^10|^11|^12|^13 (verified: Livewire 4 supports all four), Livewire ^4.1,
  PHP ^8.1, Alpine via Livewire's bundled copy (never our own).

Out of scope v1: the old form-kit `<x-uf.grid>` (stays in larafin), larafin's migration onto the
package, mobile card layouts.

---

## Package identity (proposed — confirm before P0)

| Item | Proposal |
|---|---|
| Composer name | `unnathianalytics/laragrid` |
| PHP namespace | `LaraGrid\` |
| Blade tag | `<x-laragrid :grid="$this->gridDefinition('lines')" />` |
| Livewire trait | `WithLaraGrid` (RPCs keep names: `gridFetch` / `gridOps` / `gridOptions` / `gridAction`) |
| CSS classes / tokens | rebrand `uf-dg-*` → `lgrid-*`, `--uf-dg-*` → `--lgrid-*` (one-time sed; no consumers exist yet) |
| DOM events | rebrand `ufdg:*` → `lgrid:*` (`lgrid:complete`, `lgrid:activate`, `lgrid:reseed`, ...) |
| JS extension global | `window.LaraGrid = { registerPainter, registerEditor, registerFormatter, registerCast }` |
| Config file | `config/laragrid.php` — global defaults only (density, date display, fyStartMonth, toolbar defaults); everything overridable per grid via chains |
| License | MIT (confirm) |

---

## Affected Items (new repository layout)

```
laragrid/
├── composer.json                 # require: php ^8.1, illuminate/* ^10|^11|^12|^13, livewire ^4.1
├── config/laragrid.php
├── src/
│   ├── LaraGridServiceProvider.php   # views, config, FormatRegistry+CastRegistry singletons, asset injection
│   ├── Grid.php  GridDensity.php  SyncPolicy.php  ColumnGroup.php  Aggregate.php
│   ├── Columns/                  # Column base + Serial/Text/Integer/Decimal/Date/Select/
│   │                             # SearchSelect/Checkbox/Hidden/Computed/Formula/Readonly + Concerns/
│   ├── Actions/                  # NEW: Action, ActionColumn (row/bulk/toolbar actions)
│   ├── Casting/                  # NEW: Cast contract + CastRegistry (text/int/decimal/select/bool/date)
│   ├── Formatting/               # Format, Formatter, FormatRegistry + text/number/date formatters
│   ├── Filters/  Query/  Expression/  Validation/  Editing/  Support/
│   ├── Livewire/WithLaraGrid.php
│   └── View/DatagridComponent.php
├── resources/
│   ├── js/                       # ported datagrid modules + vendored shared/date.js + NEW toolbar/
│   ├── css/laragrid.css          # self-contained token defaults (no Tailwind dependency)
│   └── views/                    # datagrid.blade.php + cells/{badge,edit-link}.blade.php (de-Fluxed)
├── dist/                         # committed prebuilt laragrid.min.js + laragrid.min.css (esbuild)
├── tests/                        # Pest + Orchestra Testbench; Unit/Feature ports; vectors/
│   └── fixtures/grid-vectors/    # expressions/formats/navigation/parse JSON — the PHP↔JS drift lock
├── package.json + build/         # package-dev only (esbuild); consumers never touch it
└── docs/                         # README, API reference, theming, extending, recipes (INR/paise)
```

Excluded from core (become documented recipes / a future companion package):
`AmountColumn`, `RupeeTextColumn`, `QtyColumn`, `InrFormatter`, `QtyFormatter`, the `paise` cast
(`Money::toPaise`), `IndianNumber` — the two hard `App\` couplings die with this split.
`DateColumn` stays but FY behavior becomes neutral: `fyStartMonth` off by default, enable via
config or `->financialYear()`.

---

## Implementation Steps

**P0 — Skeleton.** composer.json, service provider, Testbench + Pest + Pint + PHPStan wiring,
esbuild pipeline producing `dist/`, CI matrix (Laravel 10–13 × PHP 8.1–8.4, bounded by each
Laravel's own floor).

**P1 — PHP core port.** Move `app/Grid` → `src/`, rename namespace, rebrand strings. Introduce
`CastRegistry` and route `OpApplier::castValue()` through it (removes `Money`). Trim FormatRegistry
to text/number/date. Port `CellHtml` with two package-owned partials. Keep golden-config discipline:
port the config fixtures and keep serialization byte-stable.

**P2 — JS port.** Copy modules, vendor `shared/date.js`, rebrand classes/events, make the static
`FORMATTERS` and parse-kind maps registry-based (mirroring PHP), expose `window.LaraGrid` seams.
Entry point registers on `alpine:init` exactly as today.

**P3 — CSS port.** Replace Tailwind `@theme` var references with self-contained defaults (keep the
variables as the override seam), add `--lgrid-max-h` for the height API, keep print collapse and
`.dark` token overrides.

**P4 — Asset delivery.** Livewire-style auto-injection of `dist/` script+link on pages that render
a grid (response-level, opt-out via config) + `@laragridScripts`/`@laragridStyles` directives for
manual control. Injection must execute before Livewire boots Alpine (same slot Livewire uses).

**P5 — Blade + trait.** `<x-laragrid>` component, `WithLaraGrid` trait, `reseedGrid()` legal on
display grids too (lift the editable-only restriction; client listener installed in all modes).

**P6 — Dictated spec deltas** (each a chained method, no blade wiring):
- Toolbar: JS-rendered inside the mount from `layout.toolbar` — search box (debounced →
  PageSource), filter controls, per-page select, column-chooser button, toolbar actions.
  `->toolbar(...)` / `->toolbar(false)`.
- Focus: `->focusOnMount()`, `->focusOutTo(selector)`, `->onCompleteFocus(selector)` (built-in
  retry), automatic focus-return after `panel-done`/reseed.
- Keymap: **Delete = clear active cell/selection** (batch of null sets through the normal commit
  pipeline, locked/readonly cells skipped); **Shift+Delete or F7 = row delete** (minRows-guarded).
- Rows: `->defaultRows(n)` + `->newRowUsing(closure)` — seeds mount rows AND becomes the server's
  insert template (replaces the all-nulls `blankRow`), auto-`_k`.
- minRows correctness: client pre-checks `layout.minRows` before optimistic remove; any FAILED
  structural op (insert/remove/dup) returns an authoritative rows snapshot the client adopts
  (closes the drift defect found in review).
- Sizing: `->height('400px')` / `->maxHeight('60vh')` / `->fillParent()` → CSS var.
- `->emptyState('text')`.
- Panels: `->opensPanel('name')` + trait-side `gridPanelDone('grid')`; no blade listeners.

**P7 — Actions system** (net-new; design from conversation):
`Action::make()->label()->icon()->url(closure)|->call(closure)->confirm()->visible(closure)`;
`->actions([...])` (row column, URLs baked server-side like `_activateUrl`, invisible = not
emitted), `->bulkActions([...])` (checkbox-selector gutter + toolbar bulk bar), `->toolbarActions()`.
New `gridAction` RPC on the trait — same fail-closed `->authorize()` + per-action server re-check;
response can instruct refetch (readonly) or reseed (editable). Confirm dialogs ride PopupManager.
Keyboard: context-menu key opens row actions in the popup.

**P8 — Tests & docs.** Port Unit/Feature suites to Testbench; vector parity (Pest + `node --test`);
Workbench demo app with all three modes + toolbar + actions; README + API reference + theming +
extension guides + INR/paise recipe (how larafin re-registers its columns/formatters/casts).

Workflow: this repo adopts the same docs lifecycle as larafin (`docs/plans/` → verify → 
`docs/completed/` + `docs/project_plan.md` mapping). No automated commits/push.

---

## Verification / Testing Plan

1. Full Pest suite green under Testbench on the CI matrix (Laravel 10, 11, 12, 13).
2. Vector fixtures: PHP Evaluator/Formatters/RuleCompiler/casts output ≡ JS ExprEval/formatters/
   ClientValidator/parse for every committed vector.
3. Golden config snapshots: serialized configs for demo grids committed and diffed.
4. Fresh-app smoke: new Laravel skeleton + `composer require` (path repo) → display, readonly,
   editable demo pages render and operate with zero npm steps.
5. Manual keyboard walkthrough per mode: serpentine entry, Delete-clear, Shift+Delete/F7,
   auto-append, complete-guard focus hop, toolbar search/filter, actions with confirm.
6. Browser tests (Pest 4 browser plugin) for the client-only behaviors: keymap changes, minRows
   refusal rollback, toolbar, focus chains — environment permitting.

---

## Risks & Assumptions

- **Laravel 10 is EOL** (security fixes ended early 2025): constraints will allow it, CI covers it,
  but documented as best-effort.
- **Auto-injection ordering**: our script must register `alpine:init` before Livewire starts Alpine;
  mitigated by injecting alongside Livewire's own asset injection; fallback directives exist.
- **Dual-runtime drift** remains the structural risk (R2): the vector suite ships in the package and
  runs in CI on both runtimes; consumer extension docs mandate vector pairs for custom casts/formatters.
- **Rebrand churn**: renaming classes/events touches every JS module and ported test once; done in
  P1/P2 while there are zero consumers. Alternative (keep `uf-dg`) rejected unless you say otherwise.
- Livewire pinned `^4.1` (larafin-proven); minor-version `wire:ignore`/morph behavior watched via
  the morph-guard test.
- Assumption: larafin later becomes the package's first real consumer (validates §3.11) — separate
  plan, not part of v1.

---

## Decisions (resolved 2026-07-14)

1. Composer name **`unnathianalytics/laragrid`**, license MIT.
2. Prefix rebrand **approved**: `uf-dg-*` → `lgrid-*`, `ufdg:*` → `lgrid:*`.
3. Actions system ships **in v1** (P7 stays in scope).
4. v1.1 roadmap **pre-approved**: `=formula` cell entry, undo/redo, row move (Alt+↑/↓), fill-right,
   draft-recovery journal, virtual scrolling, export, row grouping, multi-aggregate footer, TS definitions.
5. `DateColumn` neutral default **confirmed** (FY inference opt-in; larafin recipe re-enables April FY).
