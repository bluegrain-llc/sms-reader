// Keep the browser QR renderer local and reproducible; it performs no network requests.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
await build({ entryPoints: ['node_modules/qrcode/lib/browser.js'], bundle: true, platform: 'browser', format: 'esm', minify: true,
  outfile: 'server/public/onboarding-qr.js', banner: { js: '/*\nBundled qrcode and dijkstrajs.\n' + readFileSync('node_modules/qrcode/license', 'utf8') + '\n' + readFileSync('node_modules/dijkstrajs/LICENSE.md', 'utf8') + '\n*/' } });
