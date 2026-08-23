{{--
    The <x-laragrid> mount. An optional Livewire-owned toolbar slot (morphable host chrome)
    sits above a single `wire:ignore` region carrying the whole client-rendered grid — JS owns
    every node inside it; Livewire never renders or morphs a cell. The vanilla boot module
    (dist/laragrid.min.js) discovers the mount by `data-lgrid`, reads the JSON config block,
    and resolves each chrome element by its `data-lgrid-ref`. No directives, no
    per-page configuration — behavior is declared on the Grid definition (zero-blade-config).
--}}
<div>
    @isset($toolbar)
        {{-- Optional HOST chrome (morphable, Livewire-owned). Grids using the package's own
             toolbar don't need this slot; a host that renders one usually chains ->toolbar(false). --}}
        <div class="lgrid-toolbar-host mb-2">
            {{ $toolbar }}
        </div>
    @endisset

    <div wire:ignore>
        <div data-lgrid tabindex="0" class="lgrid">
            {{-- The declarative config (ConfigSerializer output). @json hex-escapes <, >, &,
                 quotes, so `</script>` can never break out of this block (XSS-safe embed). --}}
            <script type="application/json" data-lgrid-config>@json($config)</script>

            {{-- Package-rendered toolbar (P6): search / filters / column chooser, built
                 client-side from layout.toolbar. Hidden until something qualifies. --}}
            <div data-lgrid-ref="toolbar" class="lgrid-toolbar" hidden></div>

            <div data-lgrid-ref="scroll" class="lgrid-scroll">
                <div data-lgrid-ref="head" class="lgrid-head"></div>
                <div data-lgrid-ref="body" class="lgrid-rows lgrid-rows--cv"></div>
                <div data-lgrid-ref="footer" class="lgrid-footer" hidden></div>

                {{-- Loading overlay: shown while a server fetch (gridFetch) is in flight. --}}
                <div data-lgrid-ref="loading" class="lgrid-loading" hidden aria-hidden="true">
                    <span class="lgrid-loading-spinner"></span>
                </div>

                {{-- The single floating editor host: EditorManager positions it over the active
                     cell and mounts the per-type editor input into it. One element per grid.
                     Only used by an editable grid. --}}
                <div data-lgrid-ref="editor" class="lgrid-cell-editor" hidden></div>
            </div>

            {{-- The single layered popup: option lists, paste confirm, column chooser. A child
                 of the grid ROOT (not the scroll container) so the scroll clip can't cut it off. --}}
            <div data-lgrid-ref="popup" class="lgrid-popup" hidden></div>

            {{-- Server-side pagination chrome; client-rendered, populated only for ->query() grids. --}}
            <div data-lgrid-ref="pagination" class="lgrid-pagination" hidden></div>

            {{-- Excel-style selection status bar (Sum · Count · Avg). --}}
            <div data-lgrid-ref="statusbar" class="lgrid-statusbar" hidden></div>

            {{-- Editable sync state: explicit retry/offline/failed feedback instead of a frozen UI. --}}
            <div class="lgrid-syncbar" role="status" aria-live="polite">
                <span data-lgrid-ref="syncStatus">Saved</span>
                <button data-lgrid-ref="syncRetry" type="button" class="lgrid-sync-retry" hidden>
                    {{ __('Retry now') }}
                </button>
            </div>

            {{-- Editable error summary + actionable message list. Ctrl+E focuses an error. --}}
            <div class="lgrid-errorbar">
                <span class="lgrid-errorbar-icon" aria-hidden="true">!</span>
                <button data-lgrid-ref="errorReview" type="button" class="lgrid-error-review"
                        aria-expanded="false" hidden>
                    <span data-lgrid-ref="errorCount" class="lgrid-errorbar-count">0</span>
                    <span>{{ __('errors — Review') }}</span>
                </button>
                <button data-lgrid-ref="errorPrev" type="button" class="lgrid-error-nav"
                        aria-label="{{ __('Previous grid error') }}">↑</button>
                <button data-lgrid-ref="errorNext" type="button" class="lgrid-error-nav"
                        aria-label="{{ __('Next grid error') }}">↓</button>
            </div>
            <div data-lgrid-ref="errorPanel" class="lgrid-error-panel" role="region"
                 aria-label="{{ __('Grid validation errors') }}" hidden>
                <ol data-lgrid-ref="errorList" class="lgrid-error-list"></ol>
            </div>

            {{-- Opt-in IndexedDB draft recovery prompt (->persistDraft()). --}}
            <div data-lgrid-ref="draftBar" class="lgrid-draftbar" role="status" hidden>
                <span data-lgrid-ref="draftMessage"></span>
                <button data-lgrid-ref="draftRestore" type="button">{{ __('Restore') }}</button>
                <button data-lgrid-ref="draftDiscard" type="button">{{ __('Discard') }}</button>
            </div>

            {{-- Screen-reader announcer: active-cell / selection / clipboard changes. --}}
            <div data-lgrid-ref="announcer" class="lgrid-sr-only" aria-live="polite" aria-atomic="true"></div>

            {{-- Empty-state fallback the JS surfaces when the grid has zero rows. --}}
            <template data-lgrid-ref="emptyTemplate">
                <div class="lgrid-empty">{{ __('No rows to display.') }}</div>
            </template>
        </div>
    </div>
</div>
