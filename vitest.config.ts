import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Parsing eleven STEP files through the OCCT wasm build is not instant.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
