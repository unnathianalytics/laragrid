/**
 * LaraGrid dist builder (package-development only).
 *
 * What: Bundles resources/js/index.js → dist/laragrid.min.js (IIFE, self-registering) and
 *       minifies resources/css/laragrid.css → dist/laragrid.min.css, then writes the
 *       precompressed siblings (.br/.gz) the AssetController serves to browsers that accept
 *       them, and dist/version.txt — the content hash Support\Assets stamps on the tags.
 * Why:  The committed dist/ is what the service provider serves/injects — consumers never
 *       run a JS build. Alpine and Livewire are runtime globals provided by Livewire's own
 *       script, so nothing is bundled besides our modules (no externals needed). Shipping the
 *       compressed files means a host that does not compress dynamic responses still sends
 *       ~37 KB instead of ~160 KB; the version file saves a 160 KB md5 per PHP request.
 *       Consumers with their own Vite build import resources/js/index.js directly — the old
 *       ESM bundle was never documented and is no longer built.
 * When: `npm run build` before tagging a release; CI verifies dist/ is in sync with source
 *       (a byte diff for the text files, a decode check for the compressed siblings).
 */
import * as esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

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
        // External map without embedded sources: the .map stays in the repository for
        // debugging but is excluded from the Composer archive (.gitattributes), so the
        // bundle must not advertise it with a sourceMappingURL comment (a 404 per devtools open).
        sourcemap: 'external',
        sourcesContent: false,
        // `import.meta` has no meaning in an IIFE, so every bare occurrence must be defined
        // away or esbuild warns and substitutes an empty stand-in. Longest key wins, so the
        // .DEV leaf still resolves to false and the dev-only guards constant-fold out.
        define: {
            'import.meta.env.DEV': 'false',
            'import.meta.env': '{}',
            'import.meta': '{}',
        },
    },
    {
        entryPoints: ['resources/css/laragrid.css'],
        outfile: 'dist/laragrid.min.css',
        bundle: true,
        minify: true,
    },
];

/** Files that get .br/.gz siblings (served by AssetController on Accept-Encoding). */
const compressed = ['dist/laragrid.min.js', 'dist/laragrid.min.css'];

/**
 * Write the precompressed siblings and the version stamp. The bundle, stylesheet, map and
 * stamp rebuild byte for byte on any platform, so a rebuild of unchanged source leaves them
 * untouched. The siblings carry no timestamp (brotli has none; Node's gzip writes MTIME 0),
 * but their bytes still depend on the zlib build: Linux and Windows Node disagree on gzip.
 * CI therefore checks them by decoding (build/check-compressed.mjs) rather than by diff.
 */
function finalize() {
    for (const file of compressed) {
        const source = readFileSync(file);
        writeFileSync(file + '.br', brotliCompressSync(source, {
            params: {
                [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
                [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length,
            },
        }));
        writeFileSync(file + '.gz', gzipSync(source, { level: 9 }));
    }
    // Same digest PHP's md5_file() fallback computes, so a missing file degrades to the same value.
    const hash = createHash('md5').update(readFileSync('dist/laragrid.min.js')).digest('hex');
    writeFileSync('dist/version.txt', hash.slice(0, 12) + '\n');
}

for (const options of builds) {
    if (watch) {
        const ctx = await esbuild.context(options);
        await ctx.watch();
    } else {
        await esbuild.build(options);
    }
}

if (watch) {
    console.log('laragrid: watching for changes… (precompressed files and version.txt are written by a plain `npm run build`)');
} else {
    finalize();
    console.log('laragrid: dist/ built.');
}
