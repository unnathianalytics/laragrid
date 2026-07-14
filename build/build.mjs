/**
 * LaraGrid dist builder (package-development only).
 *
 * What: Bundles resources/js/index.js → dist/laragrid.min.js (IIFE, self-registering) and
 *       dist/laragrid.esm.js (for consumers who import into their own Vite build), and
 *       minifies resources/css/laragrid.css → dist/laragrid.min.css.
 * Why:  The committed dist/ is what the service provider serves/injects — consumers never
 *       run a JS build. Alpine and Livewire are runtime globals provided by Livewire's own
 *       script, so nothing is bundled besides our modules (no externals needed).
 * When: `npm run build` before tagging a release; CI verifies dist/ is in sync with source.
 */
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
    {
        entryPoints: ['resources/js/index.js'],
        outfile: 'dist/laragrid.min.js',
        bundle: true,
        minify: true,
        format: 'iife',
        target: 'es2020',
        sourcemap: true,
        define: { 'import.meta.env.DEV': 'false' },
    },
    {
        entryPoints: ['resources/js/index.js'],
        outfile: 'dist/laragrid.esm.js',
        bundle: true,
        minify: false,
        format: 'esm',
        target: 'es2020',
        sourcemap: true,
        define: { 'import.meta.env.DEV': 'false' },
    },
    {
        entryPoints: ['resources/css/laragrid.css'],
        outfile: 'dist/laragrid.min.css',
        bundle: true,
        minify: true,
    },
];

for (const options of builds) {
    if (watch) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
    } else {
        await esbuild.build(options);
    }
}

if (watch) {
    console.log('laragrid: watching for changes…');
} else {
    console.log('laragrid: dist/ built.');
}
