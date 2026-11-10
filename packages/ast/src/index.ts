/**
 * @jsseal/ast — 解析/打印/快照/自由变量分析（Babel 封装）
 */

import { parse, type ParserPlugin, type ParserOptions } from '@babel/parser';
import generate from '@babel/generator';
import traverseModule from '@babel/traverse';
import type * as BabelTypes from '@babel/types';
import { createHash } from 'node:crypto';

// @babel/traverse CJS 互操作
const traverse = (traverseModule as unknown as { default?: typeof traverseModule }).default ?? traverseModule;

export type { Node, NodePath } from '@babel/traverse';
export type File = BabelTypes.File;
export type Node2 = BabelTypes.Node;

export interface ParseOptions {
  /** 默认 unambiguous（script 优先，含 import/export 则 module） */
  sourceType?: ParserOptions['sourceType'];
}

export function parseCode(code: string, opts: ParseOptions = {}): File {
  const options: ParserOptions = {
    sourceType: opts.sourceType ?? 'unambiguous',
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowUndeclaredExports: true,
    errorRecovery: true,
    plugins: [] as ParserPlugin[],
  };
  return parse(code, options) as File;
}

export function printCode(ast: File | BabelTypes.Node): string {
  return generate(ast as BabelTypes.Node, {
    comments: true,
    compact: false,
    retainLines: false,
    jsescOption: { minimal: true },
  }).code;
}

/** 稳定哈希（快照/报告用） */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex').slice(0, 16);
}

/** 源码切片（按节点 range，用于 FunctionRegistry 原始文本提取） */
export function sliceSource(code: string, start: number | null | undefined, end: number | null | undefined): string {
  if (start === undefined || start === null || end === undefined || end === null) return '';
  return code.slice(start, end);
}

/**
 * 自由变量分析：未被本地绑定解析的全局引用（"缺什么环境"报告的数据源）。
 * 排除常见的宿主/语言内置名。
 */
const BUILTIN_GLOBALS = new Set([
  'globalThis', 'window', 'self', 'global', 'this',
  'Object', 'Function', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN',
  'undefined', 'Boolean', 'String', 'Symbol', 'Date', 'Promise', 'RegExp', 'Error',
  'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
  'JSON', 'Math', 'console', 'Intl', 'ArrayBuffer', 'Uint8Array', 'Int8Array',
  'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'BigInt64Array', 'BigUint64Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy',
  'Reflect', 'BigInt', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent',
  'escape', 'unescape', 'eval', 'isFinite', 'isNaN', 'arguments',
  'DataView', 'Atomics', 'SharedArrayBuffer', 'WeakRef', 'FinalizationRegistry',
  'AggregateError',
  // jsseal prelude 提供
  'setTimeout', 'setInterval', 'setImmediate', 'requestAnimationFrame', 'requestIdleCallback',
  'clearTimeout', 'clearInterval', 'cancelAnimationFrame', 'cancelIdleCallback',
  'queueMicrotask', 'structuredClone', 'atob', 'btoa', 'TextEncoder', 'TextDecoder',
  'performance', 'crypto', 'localStorage', 'sessionStorage', 'navigator', 'location',
  'document', 'screen', 'history', 'addEventListener', 'removeEventListener',
  'dispatchEvent', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'getComputedStyle',
  'matchMedia', 'alert', 'confirm', 'prompt', 'open', 'close',
  'postMessage', 'importScripts', 'Blob', 'URL', 'URLSearchParams', 'FormData',
  'Headers', 'AbortController', 'Event', 'CustomEvent', 'EventTarget', 'MessageChannel',
  'Notification', 'ServiceWorker', 'indexedDB', 'caches', 'origin', 'top', 'parent',
  'frames', 'length', 'name', 'status', 'closed', 'opener', 'onload',
]);

export function freeVariables(ast: File): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  try {
    traverse(ast, {
      ReferencedIdentifier(path) {
        const name = path.node.name;
        if (seen.has(name)) return;
        if (BUILTIN_GLOBALS.has(name)) return;
        const binding = path.scope.getBinding(name);
        if (binding) return; // 本地绑定
        seen.add(name);
        counts.set(name, (counts.get(name) ?? 0) + 1);
      },
    });
  } catch {
    /* errorRecovery 下 traverse 可能抛错——尽力而为 */
  }
  return counts;
}

export { traverse, generate };
