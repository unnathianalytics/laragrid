/**
 * Verifies that the committed precompressed siblings (dist/*.br, dist/*.gz) decode to the
 * committed plain files byte for byte.
 *
 * Why: CI checks that dist/ matches a fresh build. The bundle, stylesheet, map and version
 *      stamp rebuild identically on every platform, but the compressed bytes do not: gzip
 *      output differs between zlib builds (Linux and Windows Node disagree), and brotli may
 *      too. Comparing the siblings by content instead of by identity keeps the check honest
 *      (a stale sibling still fails) without failing a correct commit built elsewhere.
 * When: `node build/check-compressed.mjs`, before `npm run build` in CI so the committed
 *       siblings, not the freshly built ones, are the subject.
 */
import { readFileSync } from 'node:fs';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

const files = ['dist/laragrid.min.js', 'dist/laragrid.min.css'];
const decoders = [['.br', brotliDecompressSync], ['.gz', gunzipSync]];

let stale = 0;
for (const file of files) {
    const plain = readFileSync(file);
    for (const [suffix, decode] of decoders) {
        const same = decode(readFileSync(file + suffix)).equals(plain);
        console.log(`${same ? 'ok   ' : 'STALE'} ${file}${suffix}`);
        if (!same) stale++;
    }
}

if (stale > 0) {
    console.error(`\n${stale} precompressed file(s) do not decode to their plain sibling: run \`npm run build\` and commit dist/.`);
    process.exit(1);
}
console.log('precompressed siblings match the committed bundle.');
