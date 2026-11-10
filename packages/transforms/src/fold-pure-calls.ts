/**
 * 通用纯调用折叠（fold-pure-calls）——purify-closures 的收益兑现：
 * top-pure 函数（自由变量全部解析到模块级**单赋值**绑定）在全字面量
 * 调用点上的返回值是常量 → 一次封闭求值 → 回填字面量。
 *
 * 这是 decoder-lookup-table 的**家族无关泛化**：不依赖 obfuscator.io 检测，
 * 任何形态的纯解码/工具函数（purify 提升后的池+解码器、自定义解密函数）
 * 都能折叠。种子有序屏障由静态门卫保证：Math.random/Date 等不在纯调用
 * 白名单 → 折叠不会删掉种子调用（锚库再兜底）。
 *
 * 静态门卫（保守，任一不满足即弃）：
 * - F 是模块顶层函数声明；自由变量的模块级绑定必须 binding.constant
 *   （单赋值——值在全程等于初始值）；未绑定全局必须在纯白名单
 *   （Math/String/parseInt…，console/document 等一律拒绝）
 * - F 体内：写目标（赋值/自增/delete）的根标识符必须在 F 内部绑定；
 *   禁 this/arguments/eval/new/with/yield/await/标签模板
 * - 调用白名单：纯内建（Math.floor/String.fromCharCode/字符串与数组的
 *   只读方法/JSON.parse…）或**候选集内的模块函数**（不动点收敛——
 *   decode 调 bufferToString，两者同时通过/同时出局）
 * - F 名字引用全部是直接调用（不逃逸）且解析到同一绑定
 *
 * 求值：当前代码 + 尾部驱动（逐调用点独立 try，走 __jsseal_ret_raw 通道）
 * → 只回填原始值（string/有限 number/boolean）。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';
import type { NodePath, Scope } from '@babel/traverse';

const PURE_GLOBALS = new Set([
  'Math', 'String', 'Number', 'Boolean', 'JSON', 'Array', 'Object',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'NaN', 'Infinity', 'undefined',
  'escape', 'unescape', 'encodeURI', 'encodeURIComponent', 'decodeURI', 'decodeURIComponent',
]);
const PURE_MATH_FNS = new Set([
  'floor', 'ceil', 'round', 'abs', 'min', 'max', 'pow', 'sqrt', 'cbrt', 'trunc', 'sign',
  'hypot', 'imul', 'clz32', 'fround', 'log2', 'log10', 'exp', 'log', 'expm1', 'log1p',
  'sin', 'cos', 'tan', 'atan', 'atan2', 'asin', 'acos', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
]);
const PURE_INSTANCE_METHODS = new Set([
  // 字符串与数组的只读方法（push/pop/sort/reverse/splice/fill 等变异方法一律不在）
  'charAt', 'charCodeAt', 'codePointAt', 'at', 'indexOf', 'lastIndexOf', 'includes',
  'startsWith', 'endsWith', 'slice', 'substring', 'substr', 'toUpperCase', 'toLowerCase',
  'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd', 'repeat', 'split', 'concat',
  'toString', 'valueOf', 'localeCompare', 'normalize', 'join',
]);
const PURE_STRING_STATIC = new Set(['fromCharCode', 'fromCodePoint']);

/** 调用是否纯内建（静态白名单；callee 含 V8IntrinsicIdentifier 联合类型故收 t.Node） */
function isPureBuiltinCall(callee: t.Node): boolean {
  if (t.isIdentifier(callee)) return PURE_GLOBALS.has(callee.name);
  if (!t.isMemberExpression(callee) || callee.computed || !t.isIdentifier(callee.property)) return false;
  const obj = callee.object;
  const m = callee.property.name;
  if (t.isIdentifier(obj)) {
    if (obj.name === 'Math') return PURE_MATH_FNS.has(m);
    if (obj.name === 'String') return PURE_STRING_STATIC.has(m);
    if (obj.name === 'JSON') return m === 'parse' || m === 'stringify';
    if (obj.name === 'Number') return ['parseInt', 'parseFloat', 'isFinite', 'isNaN'].includes(m);
  }
  // 实例方法按名白名单：接收者为参数（字面量实参→原始值）或 F 内构造的局部对象
  //（其方法体同样经过本门卫扫描），无外部可变异接收者
  return PURE_INSTANCE_METHODS.has(m);
}

/** 全字面量原始参数（含一元负数）的调用点 → 源文本；否则 null */
function literalArgsText(call: t.CallExpression, code: string): string | null {
  for (const a of call.arguments) {
    const ok = t.isStringLiteral(a) || t.isNumericLiteral(a) || t.isBooleanLiteral(a) || t.isNullLiteral(a)
      || (t.isUnaryExpression(a, { operator: '-' }) && t.isNumericLiteral(a.argument));
    if (!ok) return null;
  }
  return code.slice(call.start!, call.end!);
}

/** 通用子树下钻（带父节点）；visit 返回 false 即整体否决 */
function walk(node: t.Node, visit: (n: t.Node, parent: t.Node | null) => boolean): boolean {
  let keep = true;
  const rec = (n: t.Node | null | undefined, parent: t.Node | null): void => {
    if (!n || typeof n !== 'object' || !keep) return;
    if (!visit(n, parent)) { keep = false; return; }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key.endsWith('Comments')) continue;
      const v = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && rec(c as t.Node, n));
      else if (v && typeof v === 'object' && 'type' in v) rec(v as t.Node, n);
    }
  };
  rec(node, null);
  return keep;
}

/** Identifier 是否处于被引用位置（排除非计算成员属性名等） */
function isRefPos(node: t.Identifier, parent: t.Node | null): boolean {
  if (!parent) return true;
  if (t.isMemberExpression(parent) && !parent.computed && parent.property === node) return false;
  if (t.isObjectProperty(parent) && !parent.shorthand && parent.key === node) return false;
  if (t.isObjectMethod(parent) && !parent.computed && parent.key === node) return false;
  return true;
}

/** F 内部绑定的名字集合（自身形参/局部声明/嵌套函数形参与声明/catch 参数） */
function collectLocalNames(fn: t.FunctionDeclaration): Set<string> {
  const names = new Set<string>();
  if (fn.id) names.add(fn.id.name);
  const addPattern = (p: t.Node | null | undefined): void => {
    if (!p) return;
    if (t.isIdentifier(p)) names.add(p.name);
    else if (t.isAssignmentPattern(p)) addPattern(p.left);
    else if (t.isRestElement(p)) addPattern(p.argument);
    else if (t.isArrayPattern(p)) p.elements.forEach((e) => addPattern(e));
    else if (t.isObjectPattern(p)) p.properties.forEach((pr) => addPattern(t.isRestElement(pr) ? pr : pr.value));
  };
  walk(fn, (n) => {
    if (t.isFunction(n)) (n.params as unknown as t.Node[]).forEach((p) => addPattern(p));
    if (t.isVariableDeclarator(n)) addPattern(n.id);
    if (t.isFunctionDeclaration(n) && n.id) names.add(n.id.name);
    if (t.isCatchClause(n) && n.param) addPattern(n.param);
    return true;
  });
  return names;
}

/** 单个候选函数是否通过门卫（candidateSet 供调用不动点） */
function passesGates(fn: t.FunctionDeclaration, candidateSet: Set<string>, programScope: Scope): boolean {
  const localNames = collectLocalNames(fn);
  const fnName = fn.id!.name;
  return walk(fn, (n, parent) => {
    // 一票否决形态
    if (t.isThisExpression(n) || t.isWithStatement(n) || t.isNewExpression(n)
      || t.isYieldExpression(n) || t.isAwaitExpression(n) || t.isTaggedTemplateExpression(n)) return false;
    if (t.isIdentifier(n) && isRefPos(n, parent) && (n.name === 'arguments' || n.name === 'eval')) return false;

    // 写目标：根标识符必须 F 内部绑定（局部）
    if (t.isAssignmentExpression(n) || t.isUpdateExpression(n)) {
      const lhs: t.Node = t.isAssignmentExpression(n) ? n.left : n.argument;
      let root: t.Node = lhs;
      while (t.isMemberExpression(root)) root = root.object;
      return t.isIdentifier(root) && localNames.has(root.name);
    }
    if (t.isUnaryExpression(n) && n.operator === 'delete') {
      let root: t.Node = n.argument;
      while (t.isMemberExpression(root)) root = root.object;
      return t.isIdentifier(root) && localNames.has(root.name);
    }

    // 调用白名单
    if (t.isCallExpression(n)) {
      const callee = n.callee;
      if (isPureBuiltinCall(callee)) return true;
      if (t.isIdentifier(callee)) {
        if (callee.name === fnName) return true; // 自递归
        if (localNames.has(callee.name)) return true; // 局部函数（其体已被本扫描覆盖）
        if (candidateSet.has(callee.name)) return true; // 候选集模块函数（不动点）
      }
      return false;
    }

    // 自由标识符
    if (t.isIdentifier(n)) {
      if (!isRefPos(n, parent)) return true; // 属性名/键位：不是引用
      if (localNames.has(n.name) || n.name === fnName) return true;
      const b = programScope.getBinding(n.name);
      if (!b) return PURE_GLOBALS.has(n.name); // 未绑定全局：纯白名单
      if (b.scope.block.type === 'Program') return b.constant; // 模块绑定必须单赋值
      return false;
    }
    return true;
  });
}

export const foldPureCalls: Transform = {
  name: 'fold-pure-calls',
  risk: 'unsafe',
  async run(ast, ctx) {
    // ---------- 1) 候选集：模块顶层函数声明（不动点收敛） ----------
    const moduleFns = new Map<string, NodePath<t.FunctionDeclaration>>();
    let programScope: Scope | undefined;
    traverse(ast, {
      Program(p) {
        programScope = p.scope;
        for (const stmt of p.node.body) {
          if (t.isFunctionDeclaration(stmt) && stmt.id) moduleFns.set(stmt.id.name, p.get(`body.${p.node.body.indexOf(stmt)}`) as NodePath<t.FunctionDeclaration>);
        }
      },
    });
    if (!programScope || moduleFns.size === 0) return result(false, ['no module functions']);

    let candidates = new Set(moduleFns.keys());
    for (let iter = 0; iter < 8; iter++) {
      const next = new Set<string>();
      for (const name of candidates) {
        if (passesGates(moduleFns.get(name)!.node, candidates, programScope!)) next.add(name);
      }
      if (next.size === candidates.size) break;
      candidates = next;
    }
    if (candidates.size === 0) return result(false, ['no pure candidates']);

    // ---------- 2) 调用点收集（同绑定 + 不逃逸 + 字面量参数） ----------
    const fnPathByName = new Map<string, NodePath<t.FunctionDeclaration>>();
    for (const [name, fp] of moduleFns) fnPathByName.set(name, fp);
    const sitesByFn = new Map<string, Array<{ path: NodePath<t.CallExpression>; text: string; strArg: boolean }>>();
    const escapeFns = new Set<string>();
    traverse(ast, {
      Identifier(ip) {
        if (!candidates.has(ip.node.name)) return;
        if (t.isFunctionDeclaration(ip.parent) && ip.parent.id === ip.node) return; // 声明处
        if (ip.scope.getBinding(ip.node.name)?.path !== fnPathByName.get(ip.node.name)) return; // 同名不同绑定
        const p = ip.parent;
        if (t.isCallExpression(p) && p.callee === ip.node) {
          const text = literalArgsText(p, ctx.code);
          if (text !== null) {
            const list = sitesByFn.get(ip.node.name) ?? [];
            list.push({
              path: ip.parentPath as NodePath<t.CallExpression>,
              text,
              strArg: p.arguments.some((a) => t.isStringLiteral(a)),
            });
            sitesByFn.set(ip.node.name, list);
          }
          return;
        }
        escapeFns.add(ip.node.name); // 任何非调用引用 = 逃逸
      },
    });
    for (const [name, sites] of sitesByFn) {
      if (escapeFns.has(name) || sites.length === 0) sitesByFn.delete(name);
    }
    if (sitesByFn.size === 0) return result(false, [`candidates=${candidates.size} no literal sites`]);

    // ---------- 3) 封闭求值（当前代码 + 尾部驱动，__jsseal_ret_raw 通道） ----------
    const texts = [...new Set([...sitesByFn.values()].flat().map((s) => s.text))];
    const lines = texts.map((x, i) => `try{__pr[${i}]=__pf((${x}))}catch(e){}`);
    const driver =
      'var __pf=function(x){return {v:x,s:typeof x}};var __pr=[];\n' +
      lines.join('\n') +
      '\nglobalThis.__jsseal_ret_raw = JSON.stringify(__pr);';
    let out;
    try {
      out = await runSealed({ code: ctx.code + '\n' + driver, mode: 'record', backend: ctx.backend, timeoutMs: ctx.timeoutMs, memoryLimitBytes: ctx.memoryLimitBytes });
    } catch {
      return result(false, ['eval fault']);
    }
    if (!out.ok || out.flags.timeout || out.flags.oom) return result(false, ['eval fault: ' + JSON.stringify(out.flags)]);
    let values: unknown;
    try {
      values = JSON.parse(out.ret ?? 'null');
    } catch {
      return result(false, ['eval parse fault']);
    }
    if (!Array.isArray(values) || values.length !== texts.length) return result(false, ['eval shape fault']);
    const valueByText = new Map<string, string | number | boolean>();
    texts.forEach((text, i) => {
      const e = values[i] as { s?: unknown; v?: unknown } | null | undefined;
      if (!e || typeof e !== 'object') return;
      if (e.s === 'string' && typeof e.v === 'string') valueByText.set(text, e.v);
      else if (e.s === 'number' && typeof e.v === 'number' && Number.isFinite(e.v)) valueByText.set(text, e.v);
      else if (e.s === 'boolean' && typeof e.v === 'boolean') valueByText.set(text, e.v);
    });

    // ---------- 4) 回填（只回填原始值） ----------
    let folded = 0;
    let skippedCodec = 0;
    for (const sites of sitesByFn.values()) {
      for (const site of sites) {
        const v = valueByText.get(site.text);
        if (v === undefined) continue;
        // 方向守卫：字符串字面量入参 + 字符串返回 = 加密函数典型形态
        //（encrypt("hello world") → 折回密文是还原度负优化——把 inline-decoder
        //  刚内联出来的明文又加密回去，实测教训）；索引型 decoder（数字入参）
        //  不受影响照常折叠
        if (site.strArg && typeof v === 'string') { skippedCodec++; continue; }
        try {
          site.path.replaceWith(
            typeof v === 'string' ? t.stringLiteral(v) : typeof v === 'boolean' ? t.booleanLiteral(v) : t.numericLiteral(v),
          );
          folded++;
        } catch { /* skip */ }
      }
    }
    if (folded === 0) return result(false, [`no foldable values${skippedCodec ? ` (codec-guard=${skippedCodec})` : ''}`]);
    const notes = [`fns=${sitesByFn.size}`, `folded=${folded}`, `candidates=${candidates.size}`];
    if (skippedCodec > 0) notes.push(`codec-guard=${skippedCodec}`);
    return result(true, notes);
  },
};
