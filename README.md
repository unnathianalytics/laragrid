# LaraGrid

Excel-style, keyboard-first datagrid for **Laravel + Livewire**. Extracted from a production
accounting system built for Busy/Tally-trained operators — then made app-neutral.

Three modes from one fluent definition:

- **Display** — hand it rows, it paints them. Works on plain Blade pages with no Livewire at all.
- **Readonly server-side** — `->query()`: sort / global search / filters / pagination through a
  whitelisted, fail-closed pipeline. Page 1 ships in the initial config (zero-round-trip paint),
  later pages stream over a renderless RPC with an LRU cache and idle prefetch.
- **Editable** — the full spreadsheet experience: optimistic client, authoritative server, typed
  op protocol, per-cell validation both sides, formula columns (one parser, two locked
  evaluators), async pickers with row enrichment hooks, auto-append, balanced-entry completion.

Everything is configured **in your component class with chained methods — zero blade wiring,
zero npm for consumers**.

## Requirements

PHP ^8.1 · Laravel 10 / 11 / 12 / 13 · Livewire ^4.1 (installed automatically; Alpine ships
inside Livewire and is never bundled here).

## Install

```bash
composer require unnathianalytics/laragrid
```

Done. Assets auto-inject on any page that renders a grid (disable via
`config('laragrid.inject_assets')`, or place `@laragridStyles` / `@laragridScripts` manually;
`vendor:publish --tag=laragrid-assets` + `laragrid.asset_url` serves them from your CDN).

## Quick start

```php
use LaraGrid\Livewire\WithLaraGrid;
use LaraGrid\{Grid, Aggregate};
use LaraGrid\Columns\{SerialColumn, TextColumn, DecimalColumn, DateColumn,
    SelectColumn, SearchSelectColumn, CheckboxColumn, FormulaColumn, ComputedColumn};
use LaraGrid\Actions\Action;
use LaraGrid\Filters\{SelectFilter, TernaryFilter};

class ItemsIndex extends \Livewire\Component
{
    use WithLaraGrid;

    protected function grids(): array
    {
        return ['items' => Grid::make('items')
            ->query(fn () => Item::query()->with('group'))
            ->authorize('item.viewAny')                       // mandatory, fail-closed
            ->paginate(50, [25, 50, 100])
            ->defaultSort('name')
            ->searchable(['name', 'code'])
            ->filters([SelectFilter::make('group_id')->label('Group')->options(fn () => ItemGroup::pluck('name', 'id'))])
            ->rowActivate(fn ($row) => route('items.edit', $row['id'])) // Enter/dbl-click opens
            ->actions([
                Action::make('edit')->icon('✎')->url(fn ($row) => route('items.edit', $row['id'])),
                Action::make('delete')->icon('✕')->confirm('Delete this item?')
                    ->call(fn (array $row) => Item::findOrFail($row['id'])->delete()),
            ])
            ->toolbarActions([Action::make('new')->label('New Item')->url(fn () => route('items.create'))])
            ->columns([
                TextColumn::make('name')->sortable()->searchable()->grow(),
                TextColumn::make('group.name')->label('Group')->sortable('item_groups.name'),
                DecimalColumn::make('rate')->scale(2)->sortable(),
            ])
            ->footer([Aggregate::sum('rate')->format('number', ['scale' => 2])])
            ->stickyHeader()->striped()->maxHeight('65vh')];
    }

    public function render() { return view('livewire.items.index'); }
}
```

```blade
<x-laragrid :grid="$this->gridDefinition('items')" />
```

### Editable grid

```php
Grid::make('lines')
    ->editable()->rowsFrom('lines')          // binds public array $lines
    ->authorize(fn () => $this->authorize('voucher.create'))
    ->defaultRows(2)                          // with newRowUsing(), replaces hand-rolled seeding:
    ->newRowUsing(fn () => ['dc' => 'D'])     //   $this->lines = $this->gridMountRows('lines');
    ->minRows(1)->autoAppend()
    ->completeWhenBalanced('dr', 'cr')        // Σdr = Σcr ends entry → lgrid:complete
    ->onCompleteFocus('[data-save]')          // ...and focus jumps to Save (retry built in)
    ->columns([
        SerialColumn::make(),
        SelectColumn::make('dc')->options(['D' => 'Dr', 'C' => 'Cr'])->required(),
        SearchSelectColumn::make('account_id')
            ->optionsUsing(fn (string $term) => $this->searchAccounts($term))  // any source
            ->onSelect(fn ($row, $value) => $row->set('rate', ...))            // enrichment
            ->minChars(0)->limit(50)->grow(),
        DecimalColumn::make('dr')->scale(2)->lockedWhen('dc', 'C')->requiredWhen('dc', 'D'),
        DecimalColumn::make('cr')->scale(2)->lockedWhen('dc', 'D')->requiredWhen('dc', 'C'),
        FormulaColumn::make('total')->formula('dr - cr'),
    ]);
```

Save with clean rows: `$this->save($this->gridRows('lines'))`; after any out-of-band rows
mutation call `$this->reseedGrid('lines')` (display grids too: `reseedGrid('name', $freshRows)`).

## Keyboard

Serpentine `entry` keymap (default) or `excel` (`->keymap('excel')`). Arrows/Tab/Home/End/
PageUp/Dn navigate; Shift extends; Ctrl+A / Ctrl+C select/copy (TSV, paste round-trips);
**Delete clears cells; Shift+Delete or F7 deletes the row** (minRows-guarded); Insert inserts;
Ctrl+D fills down; F2 edits; Ctrl+E jumps to first error; ContextMenu / Shift+F10 opens the
row's actions menu. Type into a cell to overwrite — Excel muscle memory throughout.

## Chained behaviors (no blade config, ever)

`->toolbar()` (search / filters / column chooser; `->toolbar(false)` or per-control overrides) ·
`->focusOnMount()` · `->focusOutTo('#next')` · `->onCompleteFocus('#save')` ·
`->height('420px')` / `->maxHeight('60vh')` / `->fillParent()` · `->emptyState('...')` ·
`->density(GridDensity::Compact)` · `->freezeColumns(2)` · `->persistWidths()` ·
`->rowClass(fn)` / `->cellClass(fn)` · `->refreshesHost([...])` · `->opensPanel('name')` +
`$this->gridPanelDone('grid')` · `->actions()` / `->bulkActions()` / `->toolbarActions()`.

## Theming

Override `--lgrid-*` CSS tokens (row height, paddings, every color) globally, under your own
`->themeClass()`, or under `.dark`. In a Tailwind v4 app the grid adopts your `--color-*`
`@theme` palette automatically; standalone it falls back to a complete neutral theme. All
elements use stable `lgrid-*` semantic classes — nothing is ever purged, everything is
restylable. Print collapses to a clean black-on-white table.

## Extending

```php
// PHP — a custom column type is a class:
class RatingColumn extends Column {
    public function painterId(): string { return 'rating'; }
    public function editorId(): ?string { return 'rating'; }
    public function parseSpec(): array { return ['kind' => 'int']; }
}
// Custom formatters + parse kinds (register the JS twin under the same name — see below):
app(FormatRegistry::class)->register('inr', new InrFormatter);
app(CastRegistry::class)->register('paise', new PaiseCast);
```

```js
// JS — the window.LaraGrid seams:
LaraGrid.registerPainter('rating', (cellEl, ctx) => { /* draw */ });
LaraGrid.registerEditor('rating', RatingEditor);       // {mount, value, focus, destroy}
LaraGrid.registerFormatter('inr', (value, args) => …); // twin of the PHP formatter
LaraGrid.registerCast('paise', { parse, editText });   // twin of the PHP cast
```

Every PHP formatter/cast **must** have a behaviourally identical JS twin — pin each pair with a
vector in `tests/fixtures/grid-vectors/` (the suite runs them through BOTH runtimes; that's how
this package survived extraction unchanged). Full worked example:
[docs/recipes/inr-paise.md](docs/recipes/inr-paise.md).

## Host events

Grid → host (bubbling DOM): `lgrid:complete`, `lgrid:activate`, `lgrid:panel`,
`lgrid:column-resized`, `lgrid:column-visibility`. Host → grid: `lgrid:reseed`,
`lgrid:panel-done`, `lgrid:toolbar` (for fully custom host toolbars).

## Testing your grids

The package suite: `composer test` (Pest via Testbench) + `npm test` (Node vector runners).
Your app tests interact through the public RPCs — `Livewire::test($host)->call('gridOps', 'lines',
['ops' => [...]])`, `->call('gridAction', 'items', 'delete', [$id])` — exactly as the browser does.

## License

MIT © Unnathi Analytics
