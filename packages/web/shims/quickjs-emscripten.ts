/**
 * quickjs-emscripten 浏览器替换：默认 \@jitl/quickjs-wasmfile-* 变体在浏览器
 * 需要独立 .wasm 文件（bundle 里没有）；换 singlefile 变体——wasm 以 base64
 * 内嵌在 JS 里，单文件即插即用（代价：bundle 增大约 1MB）。
 */
import SINGLEFILE from "@jitl/quickjs-singlefile-browser-release-sync";
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { newQuickJSWASMModuleFromVariant } from "quickjs-emscripten-core";

export { getQuickJSSync } from "quickjs-emscripten-core";

let cached: QuickJSWASMModule | undefined;

/** 与 quickjs-emscripten 的 getQuickJS 同形：返回主 WASM 模块（singlefile 变体） */
export const getQuickJS = async (): Promise<QuickJSWASMModule> => {
  cached ??= await newQuickJSWASMModuleFromVariant(SINGLEFILE);

  return cached;
};

// oxlint-disable-next-line sonarjs/no-undefined-assignment -- 与 quickjs-emscripten 同名导出对齐：真实包此处是预加载 wasm 的 promise，浏览器按需 getQuickJS 故无值，改成 null 会改变调用方看到的绑定语义
export const quickjs = undefined;
