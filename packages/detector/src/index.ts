/**
 * @jsseal/detector — 混淆家族识别（定向类操作：允许启发式，输出是假设，不承担恒等责任）
 *
 * 职责：
 *  1. 家族识别（obfuscator.io / sojson / jsjiami / awsc / packer / jsfuck / jjencode / aaencode / webpack / minified）
 *  2. obfuscator.io 解码三件套提取（字符串数组函数 / 轮转 IIFE / 解码函数）——
 *     输出可在封闭运行时独立执行的 prologue 源码切片
 */

import { parseCode, traverse } from '@jsseal/ast';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

export type Family =
  | 'obfuscator-io'
  | 'jsconfuser'
  | 'sojson'
  | 'jsjiami'
  | 'awsc'
  | 'packer'
  | 'jsfuck'
  | 'jjencode'
  | 'aaencode'
  | 'webpack'
  | 'minified'
  | 'plain'
  | 'unknown';

export interface ObfuscatorIOPlan {
  /** 解码函数名（调用点形如 name(idx[, key])） */
  decoderNames: string[];
  /** 字符串数组函数名 */
  stringArrayNames: string[];
  /** prologue 源码切片（含三件套，源码顺序拼接，可在封闭运行时独立执行） */
  prologueSource: string;
  /** 轮转 IIFE 的语句位置数（报告用） */
  rotateCount: number;
}

export interface Detection {
  family: Family;
  confidence: number;
  features: string[];
  obfuscatorIO?: ObfuscatorIOPlan;
}

const HEX_NAME = /^_?0x[0-9a-fA-F]{3,}$/;

/** 统计函数体内字符串字面量数组的规模（允许混合元素——sojson v7 首元素是标识符） */
function bigStringArraySize(fn: NodePath<t.FunctionDeclaration>): number {
  let best = 0;
  fn.traverse({
    ArrayExpression(p) {
      const els = p.node.elements;
      const strCount = els.filter((e) => t.isStringLiteral(e)).length;
      if (els.length >= 8 && strCount >= 8) {
        best = Math.max(best, els.length);
      }
    },
  });
  return best;
}

function truthyLike(test: t.Expression): boolean {
  if (t.isBooleanLiteral(test)) return test.value;
  // !![]
  if (t.isUnaryExpression(test) && test.operator === '!') {
    const a = test.argument;
    if (t.isUnaryExpression(a) && a.operator === '!' && (t.isArrayExpression(a.argument) || t.isObjectExpression(a.argument))) {
      return true;
    }
  }
  return false;
}

export function detect(code: string): Detection {
  const features: string[] = [];
  const src = code.slice(0, 4096);

  // ---------- 字符串级家族 ----------
  if (/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)/.test(code)) {
    features.push('packer-signature');
    return { family: 'packer', confidence: 0.99, features };
  }
  const nonJsfuck = code.replace(/[\[\]()!+]/g, '');
  if (code.length > 200 && nonJsfuck.length / code.length < 0.15) {
    features.push('jsfuck-charset');
    return { family: 'jsfuck', confidence: 0.95, features };
  }
  if (src.includes('$=~[]') || /\$\s*=\s*~\s*\[\]/.test(src)) {
    features.push('jjencode-signature');
    return { family: 'jjencode', confidence: 0.9, features };
  }
  if (code.includes('ﾟωﾟ') || code.includes('(ﾟｰﾟ)')) {
    features.push('aaencode-signature');
    return { family: 'aaencode', confidence: 0.9, features };
  }
  if (code.includes('sojson') || code.includes('SOJSON')) {
    features.push('sojson-marker');
    return { family: 'sojson', confidence: 0.8, features };
  }
  if (/__p_[a-zA-Z0-9]{4}_cff_/.test(code)) {
    features.push('jsconfuser-cff-signature');
    return { family: 'jsconfuser', confidence: 0.85, features };
  }
  if (/jsjiami/i.test(code)) {
    /* sojson/jsjiami 是 obfuscator.io 衍生——标记不短路：三件套若能提取，
     * 走 obfuscator-io 管线（实测 sojson v7 教训：提前 return 导致提取从未运行） */
    features.push('jsjiami-marker');
  } else if (code.includes('awsc') || code.includes('aliyun-oss-rs')) {
    features.push('awsc-marker');
  }
  if (code.includes('__webpack_require__') || code.includes('webpackBootstrap')) {
    features.push('webpack-runtime');
    return { family: 'webpack', confidence: 0.95, features };
  }

  // ---------- AST 级特征（obfuscator.io） ----------
  let ast: ReturnType<typeof parseCode>;
  try {
    ast = parseCode(code);
  } catch {
    return { family: 'unknown', confidence: 0, features: ['parse-failed'] };
  }

  let hexNameCount = 0;
  const stringArrayFns: NodePath<t.FunctionDeclaration>[] = [];

  traverse(ast, {
    Identifier(path) {
      if (HEX_NAME.test(path.node.name)) hexNameCount++;
    },
    FunctionDeclaration(path) {
      if (bigStringArraySize(path) >= 8) {
        stringArrayFns.push(path);
        features.push(`string-array-fn:${path.node.id?.name}(n>=8)`);
      }
    },
  });

  // 池变换器收集（二段：需要先拿到数组函数名——sojson v7 的轮转是 for+reverse/push 形态，
  // 经典 while+push/shift 判定漏识别导致 prologue 池为轮转前状态、inline 全错——实测教训）
  const rotateIIFENodes: t.Statement[] = [];
  const rotateSlices: string[] = [];
  const poolNameSet = new Set(stringArrayFns.map((p) => p.node.id?.name).filter(Boolean) as string[]);
  traverse(ast, {
    ExpressionStatement(path) {
      if (isPoolRotatorStatement(path.node, poolNameSet)) {
        rotateIIFENodes.push(path.node);
        if (path.node.start != null && path.node.end != null) {
          rotateSlices.push(code.slice(path.node.start, path.node.end));
        }
        features.push('rotate-iife');
      }
    },
  });

  // 解码函数：非字符串数组函数，引用了字符串数组名，或包含典型解码原语
  const stringArrayNames = new Set(stringArrayFns.map((p) => p.node.id?.name).filter(Boolean) as string[]);
  const decoderNames: string[] = [];
  const decoderSlices: string[] = [];
  traverse(ast, {
    FunctionDeclaration(path) {
      const name = path.node.id?.name;
      if (!name) return;
      if (stringArrayNames.has(name)) return;
      if (stringArrayFns.some((sa) => sa.node === path.node)) return;
      let refsArray = false;
      let hasDecodePrimitive = false;
      path.traverse({
        Identifier(ip) {
          if (stringArrayNames.has(ip.node.name)) refsArray = true;
        },
        MemberExpression(mp) {
          const prop = mp.node.property;
          const pName = t.isIdentifier(prop) ? prop.name : t.isStringLiteral(prop) ? prop.value : '';
          if (pName === 'fromCharCode' || pName === 'charCodeAt' || pName === 'charAt' || pName === 'push' || pName === 'shift') {
            hasDecodePrimitive = true;
          }
        },
      });
      // 解码函数判定：引用了字符串数组函数名即候选（encoding:'none' 时解码器
      // 只是索引+偏移，没有 fromCharCode/charAt 等原语；primitives 仅作特征记录）
      if (refsArray) {
        decoderNames.push(name);
        if (path.node.start != null && path.node.end != null) {
          decoderSlices.push(code.slice(path.node.start, path.node.end));
        }
        if (hasDecodePrimitive) features.push(`decoder-primitives:${name}`);
      }
    },
  });

  if (stringArrayFns.length > 0 && (decoderNames.length > 0 || rotateIIFENodes.length > 0)) {
    const arraySlices = stringArrayFns.map(
      (p) => (p.node.start != null && p.node.end != null ? code.slice(p.node.start, p.node.end) : ''),
    );
    if (hexNameCount > 20) features.push(`hex-names:${hexNameCount}`);
    // 三件套切片可能引用切片外的顶层字面量（sojson v7 教训：首元素是全局 version_）
    // —— 纳入被引用的顶层字面量声明，保证 prologue 可独立执行
    const prologueBody = [...arraySlices, ...rotateSlices, ...decoderSlices].join('\n');
    const preludeDecls: string[] = [];
    try {
      for (const stmt of ast.program.body) {
        if (!t.isVariableDeclaration(stmt)) continue;
        for (const d of stmt.declarations) {
          if (!t.isIdentifier(d.id) || !d.init || !t.isLiteral(d.init)) continue;
          if (new RegExp(`\\b${d.id.name}\\b`).test(prologueBody)) {
            if (d.init.start != null && d.init.end != null) {
              preludeDecls.push(`var ${d.id.name} = ${code.slice(d.init.start, d.init.end)};`);
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
    return {
      family: 'obfuscator-io',
      confidence: 0.9,
      features,
      obfuscatorIO: {
        decoderNames,
        stringArrayNames: [...stringArrayNames],
        prologueSource: [...preludeDecls, ...arraySlices, ...rotateSlices, ...decoderSlices].join('\n'),
        rotateCount: rotateIIFENodes.length,
      },
    };
  }

  // ---------- 压缩/普通 ----------
  const lines = code.split('\n');
  const avgLen = code.length / Math.max(1, lines.length);
  if (hexNameCount > 20) {
    features.push(`hex-names:${hexNameCount}`);
    return { family: 'obfuscator-io', confidence: 0.5, features };
  }
  if (avgLen > 400) {
    features.push(`avg-line-len:${Math.round(avgLen)}`);
    return { family: 'minified', confidence: 0.7, features };
  }
  return { family: 'plain', confidence: 0.5, features };
}

/** 函数体是否包含 "while(true) + push/shift" 轮转特征 */
function containsRotateWhile(fn: t.FunctionExpression): boolean {
  let hasWhile = false;
  let hasPushShift = false;
  const walk = (node: t.Node): void => {
    if (!node || typeof node !== 'object') return;
    if (t.isWhileStatement(node) && truthyLike(node.test as t.Expression)) hasWhile = true;
    if (t.isMemberExpression(node)) {
      const p = node.property;
      const name = t.isIdentifier(p) ? p.name : t.isStringLiteral(p) ? p.value : '';
      if (name === 'push' || name === 'shift') hasPushShift = true;
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const v = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        v.forEach((c) => c && typeof c === 'object' && 'type' in c && walk(c as t.Node));
      } else if (v && typeof v === 'object' && 'type' in (v as object)) {
        walk(v as t.Node);
      }
    }
  };
  walk(fn.body);
  return hasWhile && hasPushShift;
}

/** 表达式语句是否为 obfuscator.io 轮转 IIFE（经典形态：while(!![])+push/shift） */
export function isRotateStatement(node: t.ExpressionStatement): boolean {
  const expr = node.expression;
  if (!t.isCallExpression(expr) || !t.isFunctionExpression(expr.callee)) return false;
  return containsRotateWhile(expr.callee);
}

const ARRAY_MUTATORS = new Set(['push', 'shift', 'unshift', 'pop', 'reverse', 'splice', 'sort', 'copyWithin', 'fill']);

/**
 * 通用池变换器识别（sojson v7 教训：轮转可为 for 循环 + reverse/push 等任意形态）：
 * 顶层 IIFE（Function/Arrow）子树同时满足 ① 引用池函数名 ② 含数组变异成员调用。
 * names 为空时退化为经典形态判定。
 */
export function isPoolRotatorStatement(node: t.ExpressionStatement, poolNames?: Set<string>): boolean {
  if (!poolNames || poolNames.size === 0) return isRotateStatement(node);
  let expr: t.Expression = node.expression;
  /* 序列表达式解包（sojson v7：IIFE(190), _0x2c4c && (...) 逗号连接为一条语句） */
  const candidates: t.Expression[] = [];
  if (t.isSequenceExpression(expr)) candidates.push(...expr.expressions);
  else candidates.push(expr);
  const target = candidates.find(
    (e) => t.isCallExpression(e) && (t.isFunctionExpression((e as t.CallExpression).callee) || t.isArrowFunctionExpression((e as t.CallExpression).callee)),
  );
  if (!target || !t.isCallExpression(target)) return false;
  let refsPool = false;
  let hasMutator = false;
  const walk = (n: t.Node): void => {
    if (refsPool && hasMutator) return;
    if (t.isIdentifier(n) && poolNames.has(n.name)) refsPool = true;
    if (t.isMemberExpression(n)) {
      const prop = n.property;
      const name = t.isIdentifier(prop) ? prop.name : t.isStringLiteral(prop) ? prop.value : '';
      if (ARRAY_MUTATORS.has(name)) hasMutator = true;
      /* sojson v7：方法名为变量/表达式（i[c]()、i["un"+c](e)）——计算成员调用
       * 结合"引用池函数名 + 顶层 IIFE"已足够特异 */
      if (n.computed && !t.isStringLiteral(prop) && !t.isNumericLiteral(prop)) hasMutator = true;
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const v = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && walk(c as t.Node));
      else if (v && typeof v === 'object' && 'type' in (v as object)) walk(v as t.Node);
    }
  };
  /* 经典 obfuscator.io 形态把池作为 IIFE 实参（引用在 arguments）；
   * sojson 形态在体内引用——walk 整个调用表达式（callee+arguments） */
  walk(target as t.Node);
  return refsPool && hasMutator;
}
