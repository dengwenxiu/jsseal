/**
 * \@jsseal/ast — 解析/打印/快照/自由变量分析（Babel 封装）
 */

import { createHash } from "node:crypto";

import generate from "@babel/generator";
import { parse } from "@babel/parser";
import type { ParserOptions } from "@babel/parser";
import * as traverseNamespace from "@babel/traverse";
import type { NodePath } from "@babel/traverse";
import type * as BabelTypes from "@babel/types";

// @babel/traverse CJS 互操作：__importStar 对 __esModule 模块原样返回命名空间对象，
// 故 traverse 函数本体挂在命名空间的 default 上（而非默认导入值本身）
const traverse = traverseNamespace.default;

export type { Node, NodePath } from "@babel/traverse";

export type File = BabelTypes.File;

export type Node2 = BabelTypes.Node;

export interface ParseOptions {
  /** 默认 unambiguous（script 优先，含 import/export 则 module） */
  sourceType?: ParserOptions["sourceType"];
}

export const parseCode = (code: string, opts: ParseOptions = {}): File => {
  const options: ParserOptions = {
    sourceType: opts.sourceType ?? "unambiguous",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowUndeclaredExports: true,
    errorRecovery: true,
    plugins: [],
  };

  return parse(code, options);
};

export const printCode = (ast: File | BabelTypes.Node): string =>
  generate(ast, {
    comments: true,
    compact: false,
    retainLines: false,
    jsescOption: { minimal: true },
  }).code;

/** 稳定哈希（快照/报告用） */
export const hashCode = (code: string): string =>
  createHash("sha256").update(code).digest("hex").slice(0, 16);

/** 源码切片（按节点 range，用于 FunctionRegistry 原始文本提取） */
export const sliceSource = (
  code: string,
  start: number | null | undefined,
  end: number | null | undefined
): string => {
  if (
    start === undefined ||
    start === null ||
    end === undefined ||
    end === null
  ) {
    return "";
  }

  return code.slice(start, end);
};

/**
 * 自由变量分析：未被本地绑定解析的全局引用（"缺什么环境"报告的数据源）。
 * 排除常见的宿主/语言内置名。
 */
const BUILTIN_GLOBALS = new Set([
  "globalThis",
  "window",
  "self",
  "global",
  "this",
  "Object",
  "Function",
  "Array",
  "Number",
  "parseFloat",
  "parseInt",
  "Infinity",
  "NaN",
  "undefined",
  "Boolean",
  "String",
  "Symbol",
  "Date",
  "Promise",
  "RegExp",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "JSON",
  "Math",
  "console",
  "Intl",
  "ArrayBuffer",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Proxy",
  "Reflect",
  "BigInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "eval",
  "isFinite",
  "isNaN",
  "arguments",
  "DataView",
  "Atomics",
  "SharedArrayBuffer",
  "WeakRef",
  "FinalizationRegistry",
  "AggregateError",
  // jsseal prelude 提供
  "setTimeout",
  "setInterval",
  "setImmediate",
  "requestAnimationFrame",
  "requestIdleCallback",
  "clearTimeout",
  "clearInterval",
  "cancelAnimationFrame",
  "cancelIdleCallback",
  "queueMicrotask",
  "structuredClone",
  "atob",
  "btoa",
  "TextEncoder",
  "TextDecoder",
  "performance",
  "crypto",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
  "document",
  "screen",
  "history",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "Worker",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "getComputedStyle",
  "matchMedia",
  "alert",
  "confirm",
  "prompt",
  "open",
  "close",
  "postMessage",
  "importScripts",
  "Blob",
  "URL",
  "URLSearchParams",
  "FormData",
  "Headers",
  "AbortController",
  "Event",
  "CustomEvent",
  "EventTarget",
  "MessageChannel",
  "Notification",
  "ServiceWorker",
  "indexedDB",
  "caches",
  "origin",
  "top",
  "parent",
  "frames",
  "length",
  "name",
  "status",
  "closed",
  "opener",
  "onload",
]);

/** 记录一次未被本地绑定解析的全局引用（seen 保证每名只计一次） */
const recordUnboundReference = (
  path: NodePath<BabelTypes.Identifier | BabelTypes.JSXIdentifier>,
  counts: Map<string, number>,
  seen: Set<string>
): void => {
  const { name } = path.node;

  if (seen.has(name)) {
    return;
  }

  if (BUILTIN_GLOBALS.has(name)) {
    return;
  }

  // 本地绑定
  const binding = path.scope.getBinding(name);

  if (binding) {
    return;
  }

  seen.add(name);
  counts.set(name, (counts.get(name) ?? 0) + 1);
};

export const freeVariables = (ast: File): Map<string, number> => {
  const counts = new Map<string, number>();
  const seen = new Set<string>();

  const visitReferencedIdentifier = (
    path: NodePath<BabelTypes.Identifier | BabelTypes.JSXIdentifier>
  ): void => {
    recordUnboundReference(path, counts, seen);
  };

  try {
    traverse(ast, { ReferencedIdentifier: visitReferencedIdentifier });
  } catch {
    /* errorRecovery 下 traverse 可能抛错——尽力而为 */
  }

  return counts;
};

export { traverse, generate };
