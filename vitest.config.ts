import path from "node:path";

import { defineConfig } from "vitest/config";

const pkgs = [
  "ast",
  "runtime",
  "anchors",
  "detector",
  "transforms",
  "core",
  "engine-native",
];

export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      pkgs.map((p) => [
        `@jsseal/${p}`,
        // oxlint-disable-next-line unicorn/prefer-module -- vitest 以 CJS 打包加载本配置（root package.json 为 commonjs），此处 __dirname 即仓库根；import.meta 在 CJS 下不可用
        path.resolve(__dirname, `packages/${p}/src/index.ts`),
      ])
    ),
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
