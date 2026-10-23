<div>
    @if ($show)
        <x-laragrid :grid="$this->gridDefinition('lines')" :rows="$lines" />
    @endif
    <x-laragrid :grid="$this->gridDefinition('taxes')" :rows="$taxes" />
</div>
