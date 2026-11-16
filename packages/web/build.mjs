#!/usr/bin/env node
/* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- packages/web 无 tsconfig（不参与 tsc -b），类型感知检查解析不到 node: 内置模块类型，本文件的 fs/path/esbuild 调用一律被当作 error 类型；这是构建脚本的既有形态，修它需要新增 tsconfig，超出反混淆器源码范围 */
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

/** esbuild 打包：@jsseal/core + quickjs-emscripten(wasm 内嵌) → 单 JS */
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "../..");
const web = path.resolve(root, "packages/web");

mkdirSync(path.resolve(web, "dist"), { recursive: true });

await build({
  entryPoints: [path.resolve(web, "src/main.ts")],
  bundle: true,
  format: "esm",
  target: "es2020",
  platform: "browser",
  minify: true,
  outfile: path.resolve(web, "dist/main.js"),
  legalComments: "none",
  logLevel: "info",
  alias: {
    "@jsseal/engine-native": path.resolve(web, "shims/engine-native.ts"),
    "node:crypto": path.resolve(web, "shims/node-crypto.ts"),
    crypto: path.resolve(web, "shims/node-crypto.ts"),
    "node:vm": path.resolve(web, "shims/node-vm.ts"),
    "quickjs-emscripten": path.resolve(web, "shims/quickjs-emscripten.ts"),
  },
  // Babel/emscripten 的 Node 环境探测（process.env.BABEL_* 等 33+ 处）——
  // env 查不到走默认分支即可，stub 足够
  banner: {
    js: 'globalThis.process=globalThis.process||{env:{},versions:{},type:"browser",nextTick:function(f){var a=[].slice.call(arguments,1);queueMicrotask(function(){f.apply(null,a);});},emitWarning:function(){},stderr:{}};',
  },
});

// 内置样本（小体积真实样本，便于演示）
cpSync(path.resolve(web, "index.html"), path.resolve(web, "dist/index.html"));

mkdirSync(path.resolve(web, "dist/samples"), { recursive: true });

for (const f of [
  "jsfuck.js",
  "packer-basic.js",
  "ob-stringarray-base64.js",
  "ctor-chain.js",
]) {
  try {
    cpSync(
      path.resolve(root, `packages/transforms/fixtures/${f}`),
      path.resolve(web, `dist/samples/${f}`)
    );
    cpSync(
      path.resolve(root, "samples/jsfuck.js"),
      path.resolve(web, "dist/samples/jsfuck.js")
    );
  } catch {
    /* fixture 缺失则跳过 */
  }
}

console.log("playground 构建完成: packages/web/dist/");
