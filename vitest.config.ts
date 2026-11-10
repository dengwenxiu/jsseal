import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const pkgs = ['ast', 'runtime', 'anchors', 'detector', 'transforms', 'core', 'engine-native'];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(pkgs.map((p) => [`@jsseal/${p}`, resolve(__dirname, `packages/${p}/src/index.ts`)])),
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
