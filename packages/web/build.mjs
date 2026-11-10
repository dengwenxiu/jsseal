#!/usr/bin/env node
/** esbuild 打包：@jsseal/core + quickjs-emscripten(wasm 内嵌) → 单 JS */
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const web = resolve(root, 'packages/web');

mkdirSync(resolve(web, 'dist'), { recursive: true });

await build({
  entryPoints: [resolve(web, 'src/main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  platform: 'browser',
  minify: true,
  outfile: resolve(web, 'dist/main.js'),
  legalComments: 'none',
  logLevel: 'info',
  alias: {
    '@jsseal/engine-native': resolve(web, 'shims/engine-native.ts'),
    'node:crypto': resolve(web, 'shims/node-crypto.ts'),
    crypto: resolve(web, 'shims/node-crypto.ts'),
    'node:vm': resolve(web, 'shims/node-vm.ts'),
    'quickjs-emscripten': resolve(web, 'shims/quickjs-emscripten.ts'),
  },
  // Babel/emscripten 的 Node 环境探测（process.env.BABEL_* 等 33+ 处）——
  // env 查不到走默认分支即可，stub 足够
  banner: {
    js: 'globalThis.process=globalThis.process||{env:{},versions:{},type:"browser",nextTick:function(f){var a=[].slice.call(arguments,1);queueMicrotask(function(){f.apply(null,a);});},emitWarning:function(){},stderr:{}};',
  },
});

// 内置样本（小体积真实样本，便于演示）
cpSync(resolve(web, 'index.html'), resolve(web, 'dist/index.html'));
mkdirSync(resolve(web, 'dist/samples'), { recursive: true });
for (const f of ['jsfuck.js', 'packer-basic.js', 'ob-stringarray-base64.js', 'ctor-chain.js']) {
  try {
    cpSync(resolve(root, `packages/transforms/fixtures/${f}`), resolve(web, `dist/samples/${f}`));
    cpSync(resolve(root, 'samples/jsfuck.js'), resolve(web, 'dist/samples/jsfuck.js'));
  } catch {
    /* fixture 缺失则跳过 */
  }
}
console.log('playground 构建完成: packages/web/dist/');
