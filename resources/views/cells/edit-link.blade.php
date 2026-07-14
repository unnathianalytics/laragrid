{{-- The per-row Edit link: a plain full-navigation anchor. NO wire:navigate — the grid body
     is wire:ignore'd innerHTML where the directive would silently no-op. --}}
<a href="{{ $href }}" class="lgrid-edit-link">{{ __('Edit') }}</a>
