<?php

declare(strict_types=1);

use InvalidArgumentException;
use LaraGrid\Columns\TextColumn;
use LaraGrid\Grid;
use LaraGrid\Tests\Hosts\DisplayGridComponent;
use Livewire\Livewire;

it('renders the vanilla mount contract from a livewire host', function () {
    $html = Livewire::test(DisplayGridComponent::class)->html();

    expect($html)
        ->toContain('data-lgrid')
        ->toContain('wire:ignore')
        ->toContain('data-lgrid-config')
        ->toContain('data-lgrid-ref="body"')
        ->toContain('data-lgrid-ref="popup"')
        ->toContain('data-lgrid-ref="emptyTemplate"')
        // Serialized config made it into the JSON block.
        ->toContain('"name":"taxes"')
        ->toContain('"Alpha"');
});

it('renders on a plain blade page with no livewire at all', function () {
    $grid = Grid::make('plain')->columns([TextColumn::make('name')]);

    $view = $this->blade(
        '<x-laragrid :grid="$grid" :rows="$rows" />',
        ['grid' => $grid, 'rows' => [['name' => 'Solo']]],
    );

    $view->assertSee('data-lgrid', false);
    $view->assertSee('"Solo"', false);
});

it('embeds config xss-safely — a </script> in row data cannot break out of the json block', function () {
    $grid = Grid::make('xss')->columns([TextColumn::make('name')]);

    $html = (string) $this->blade(
        '<x-laragrid :grid="$grid" :rows="$rows" />',
        ['grid' => $grid, 'rows' => [['name' => '</script><script>alert(1)</script>']]],
    );

    expect($html)
        ->not->toContain('</script><script>alert(1)')
        ->toContain('\\u003C'); // @json hex-escapes every < inside the block
});

it('computes the in-memory footer total into the config', function () {
    $html = Livewire::test(DisplayGridComponent::class)->html();

    // 10.00 + 5.50 summed server-side at serialize time.
    expect($html)->toContain('"value":15.5');
});

it('reseeds a display grid with explicit rows — any mode, not just editable', function () {
    Livewire::test(DisplayGridComponent::class)
        ->call('pushRows')
        ->assertDispatched('lgrid:reseed', function (string $event, array $params) {
            return $params['grid'] === 'taxes'
                && count($params['rows']) === 1
                && $params['rows'][0]['name'] === 'Gamma'
                && $params['rows'][0]['_k'] === 'c'
                && $params['footer']['rate'] === 7.25;
        });
});

it('throws for an unknown grid name', function () {
    $component = new DisplayGridComponent;

    $component->gridDefinition('phantom');
})->throws(InvalidArgumentException::class, 'no grid named [phantom]');
