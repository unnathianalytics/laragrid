{{-- A static badge painted into an ->html() grid cell. Composed only from escaped values —
     the G13 caller-sanitised contract; see LaraGrid\Support\CellHtml. Styled by lgrid-badge
     tokens in laragrid.css; publish laragrid-views to re-skin. --}}
<span class="lgrid-badge lgrid-badge--{{ $color }} {{ $class }}">{{ $label }}</span>
