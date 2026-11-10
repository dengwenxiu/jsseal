/**
 * quickjs-emscripten 浏览器替换：默认 @jitl/quickjs-wasmfile-* 变体在浏览器
 * 需要独立 .wasm 文件（bundle 里没有）；换 singlefile 变体——wasm 以 base64
 * 内嵌在 JS 里，单文件即插即用（代价：bundle 增大约 1MB）。
 */
import SINGLEFILE from '@jitl/quickjs-singlefile-browser-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';

export { getQuickJSSync } from 'quickjs-emscripten-core';

let cached: unknown;

/** 与 quickjs-emscripten 的 getQuickJS 同形：返回主 WASM 模块（singlefile 变体） */
export async function getQuickJS(): Promise<unknown> {
  cached ??= await newQuickJSWASMModuleFromVariant(SINGLEFILE as never);
  return cached;
}

export const quickjs = undefined;
