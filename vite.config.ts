import { defineConfig } from 'vite';

// GitHub Pages serves this project from https://<user>.github.io/step-orient/,
// so every asset URL has to be prefixed. Without this the production build
// requests /assets/... from the domain root and 404s — the single most common
// way a Pages deployment of a Vite app breaks.
const base = process.env.VITE_BASE ?? '/step-orient/';

export default defineConfig({
  base,
  build: { target: 'es2022' },
  worker: {
    // occt-import-js is an Emscripten build that detects a worker by looking
    // for importScripts, which only exists in a classic worker. A module
    // worker would leave it unable to fetch its own wasm.
    format: 'iife',
  },
});
