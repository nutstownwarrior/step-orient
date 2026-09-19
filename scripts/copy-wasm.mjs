// occt-import-js loads its .wasm at runtime from a URL. Vite only rewrites URLs
// it can see, so the wasm is staged into public/ (and therefore into dist/ with
// the right base prefix) rather than being imported.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(dirname(require.resolve('occt-import-js')), 'occt-import-js.wasm');
const dst = join(root, 'public', 'occt-import-js.wasm');

mkdirSync(dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`copied ${src} -> ${dst}`);
