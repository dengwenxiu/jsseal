/**
 * 解码函数内联（obfuscator.io string array 的特化，"纯函数 + 常量入参 → 执行内联"的第一实例）：
 *
 * 新版 obfuscator.io 的调用点走别名链：函数内 `var a = b` 链式指向解码函数
 * （_0x5e2f08 → _0x261df8 → _0x423b）。
 *
 * 流程：
 *  1. 收集别名链并解析到规范解码函数名
 *  2. 收集调用点（实参全字面量；跳过 prologue 内部——轮转 IIFE 的调用必须保留）
 *  3. 封闭运行时执行三件套 prologue，批量求值；校验种子零消费（纯度前提）
 *  4. 字面量回填 → 清理无引用别名 → prologue 外无引用时移除三件套
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { isPoolRotatorStatement } from '@jsseal/detector';
import { result, type Transform } from './types';

interface CallReq {
  path: import('@babel/traverse').NodePath<t.CallExpression>;
  name: string;
  args: unknown[];
}

function isLiteralArg(a: t.Node): a is t.StringLiteral | t.NumericLiteral {
  return t.isStringLiteral(a) || t.isNumericLiteral(a);
}

/** 表达式是否为「标识符(限 params)/字面量/一元/二元」的简单算术（包装实参合法性） */
function isSimpleArith(node: t.Node, allowed: Set<string>): boolean {
  if (t.isIdentifier(node)) return allowed.has(node.name);
  if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) return true;
  if (t.isUnaryExpression(node)) {
    return ['-', '+', '!'].includes(node.operator) && isSimpleArith(node.argument, allowed);
  }
  if (t.isBinaryExpression(node)) {
    return ['+', '-', '*', '/', '%'].includes(node.operator) && isSimpleArith(node.left, allowed) && isSimpleArith(node.right, allowed);
  }
  return false;
}

/** 静态求值：包装实参表达式在 env（参数→字面量值）下求值 */
function evalStaticArg(node: t.Expression, env: Map<string, unknown>): unknown {
  if (t.isNumericLiteral(node) || t.isStringLiteral(node) || t.isBooleanLiteral(node)) return node.value;
  if (t.isIdentifier(node)) return env.get(node.name);
  if (t.isUnaryExpression(node)) {
    const v = evalStaticArg(node.argument, env);
    if (v === undefined) return undefined;
    if (node.operator === '-') return -Number(v);
    if (node.operator === '+') return Number(v);
    return undefined;
  }
  if (t.isBinaryExpression(node)) {
    const l = evalStaticArg(node.left as t.Expression, env);
    const r = evalStaticArg(node.right as t.Expression, env);
    if (l === undefined || r === undefined) return undefined;
    switch (node.operator) {
      case '+': return (l as number) + (r as number);
      case '-': return (l as number) - (r as number);
      case '*': return (l as number) * (r as number);
      case '/': return (l as number) / (r as number);
      case '%': return (l as number) % (r as number);
      default: return undefined;
    }
  }
  return undefined;
}

export const inlineDecoder: Transform = {
  name: 'inline-decoder',
  risk: 'unsafe', // 执行求值（封闭运行时内，种子零消费校验 + 锚库把关）
  async run(ast, ctx) {
    const plan = ctx.detection.obfuscatorIO;
    if (!plan || plan.decoderNames.length === 0 || !plan.prologueSource) {
      return result(false, ['no decoder plan']);
    }
    const decoderSet = new Set(plan.decoderNames);
    const prologueNames = new Set<string>([...plan.decoderNames, ...plan.stringArrayNames]);

    // ---------- 1) 别名链：var A = B 的直连表 + 解析 ----------
    const varAliases = new Map<string, string>();
    traverse(ast, {
      VariableDeclarator(path) {
        const id = path.node.id;
        const init = path.node.init;
        if (t.isIdentifier(id) && t.isIdentifier(init)) {
          varAliases.set(id.name, init.name);
        }
      },
    });
    const resolveToDecoder = (name: string): string | null => {
      let cur = name;
      for (let i = 0; i < 8; i++) {
        if (decoderSet.has(cur)) return cur;
        const next = varAliases.get(cur);
        if (!next) return null;
        cur = next;
      }
      return null;
    };

    // ---------- 1b) 包装层（stringArrayWrappers）：w(a,b){return dec(a+off, b)} ----------
    // 参数置换/偏移的纯函数包装；调用点 w(l1,l2) 静态代入求出 decoder 实参
    const wrappers = new Map<string, { decoder: string; params: string[]; argExprs: t.Expression[] }>();
    traverse(ast, {
      FunctionDeclaration(path) {
        const name = path.node.id?.name;
        if (!name || decoderSet.has(name)) return;
        const body = path.node.body.body;
        if (body.length !== 1) return;
        const st = body[0];
        if (!t.isReturnStatement(st) || !st.argument || !t.isCallExpression(st.argument)) return;
        const callee = st.argument.callee;
        if (!t.isIdentifier(callee)) return;
        const target = resolveToDecoder(callee.name) ?? (wrappers.has(callee.name) ? callee.name : null);
        if (!target) return;
        if (!path.node.params.every((p) => t.isIdentifier(p))) return;
        const paramNames = path.node.params.map((p) => (p as t.Identifier).name);
        const argExprs = st.argument.arguments as t.Expression[];
        if (argExprs.length === 0 || !argExprs.every((e) => isSimpleArith(e, new Set(paramNames)))) return;
        wrappers.set(name, { decoder: target, params: paramNames, argExprs });
      },
    });

    /** 调用点解析：w(l1,l2) → { decoder, args }（支持别名链 + 包装链） */
    const resolveCall = (
      calleeName: string,
      argValues: unknown[],
    ): { decoder: string; args: unknown[] } | null => {
      const direct = resolveToDecoder(calleeName);
      if (direct) return { decoder: direct, args: argValues };
      let name = calleeName;
      let args = argValues;
      for (let d = 0; d < 4; d++) {
        const w = wrappers.get(name);
        if (!w) return null;
        if (args.length !== w.params.length) return null;
        if (!args.every((a) => typeof a === 'number' || typeof a === 'string' || typeof a === 'boolean')) return null;
        const env = new Map<string, unknown>(w.params.map((p, i) => [p, args[i]]));
        const next: unknown[] = [];
        for (const e of w.argExprs) {
          const v = evalStaticArg(e, env);
          if (v === undefined) return null;
          next.push(v);
        }
        const dec = resolveToDecoder(w.decoder);
        if (dec) return { decoder: dec, args: next };
        name = w.decoder;
        args = next;
      }
      return null;
    };

    const insidePrologue = (path: import('@babel/traverse').NodePath): boolean => {
      let p: import('@babel/traverse').NodePath | null = path.parentPath;
      while (p) {
        const n = p.node;
        if (t.isFunctionDeclaration(n) && n.id && prologueNames.has(n.id.name)) return true;
        if (t.isExpressionStatement(n) && isPoolRotatorStatement(n, prologueNames)) return true;
        p = p.parentPath;
      }
      return false;
    };

    // ---------- 2) 调用点收集 ----------
    const reqs: CallReq[] = [];
    traverse(ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee)) return;
        if (insidePrologue(path)) return; // 轮转 IIFE 内部调用不动
        const args = path.node.arguments;
        if (args.length === 0 || !args.every(isLiteralArg)) return;
        const argValues = args.map((a) => (a as t.StringLiteral | t.NumericLiteral).value);
        const resolved = resolveCall(callee.name, argValues);
        if (!resolved) return;
        reqs.push({ path, name: resolved.decoder, args: resolved.args });
      },
    });
    if (reqs.length === 0) return result(false, ['no literal call sites']);

    // ---------- 3) 封闭运行时批量求值 ----------
    const driverCode = `
var __reqs = ${JSON.stringify(reqs.map((r) => ({ name: r.name, args: r.args })))};
var __out = [];
for (var __i = 0; __i < __reqs.length; __i++) {
  try {
    __out[__i] = { ok: true, v: globalThis[__reqs[__i].name].apply(null, __reqs[__i].args) };
  } catch (e) {
    __out[__i] = { ok: false, e: String(e) };
  }
}
globalThis.__jsseal_ret_raw = JSON.stringify(__out);
`;
    let out;
    try {
      out = await runSealed({
        code: plan.prologueSource + '\n' + driverCode,
        mode: 'record',
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch (e) {
      return result(false, [`decoder eval fault: ${(e as Error).message}`]);
    }
    if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) {
      return result(false, [`decoder eval fault: ${JSON.stringify(out.flags)}`]);
    }
    const consumedSeeds = out.consumed.random + out.consumed.date + out.consumed.time + out.consumed.crypto;
    if (consumedSeeds > 0) {
      return result(false, [`decoder consumed ${consumedSeeds} seeds — purity precondition failed, refuse`]);
    }
    let values: Array<{ ok: boolean; v?: unknown; e?: string } | null>;
    try {
      values = JSON.parse(out.ret ?? 'null');
    } catch {
      return result(false, ['decoder eval result unparsable']);
    }
    if (!Array.isArray(values) || values.length !== reqs.length) {
      return result(false, ['decoder eval result shape mismatch']);
    }

    // ---------- 4) 回填 ----------
    let replaced = 0;
    let failed = 0;
    for (let i = 0; i < reqs.length; i++) {
      const v = values[i];
      if (!v || !v.ok) {
        failed++;
        continue;
      }
      if (typeof v.v === 'string' || typeof v.v === 'number' || typeof v.v === 'boolean') {
        reqs[i].path.replaceWith(t.valueToNode(v.v));
        replaced++;
      } else {
        failed++;
      }
    }
    if (replaced === 0) return result(false, [`eval-failed=${failed}`]);

    // ---------- 5) 清理无引用的别名声明（不动点迭代：别名链层层失效） ----------
    const aliasNames = new Set<string>();
    for (const a of varAliases.keys()) {
      if (resolveToDecoder(a)) aliasNames.add(a);
    }
    for (let iter = 0; iter < 6 && aliasNames.size > 0; iter++) {
      const refCounts = new Map<string, number>();
      traverse(ast, {
        ReferencedIdentifier(path) {
          if (aliasNames.has(path.node.name)) {
            refCounts.set(path.node.name, (refCounts.get(path.node.name) ?? 0) + 1);
          }
        },
      });
      let removedAny = false;
      const dead: Array<import('@babel/traverse').NodePath<t.VariableDeclarator>> = [];
      traverse(ast, {
        VariableDeclarator(path) {
          const id = path.node.id;
          if (!t.isIdentifier(id) || !t.isIdentifier(path.node.init)) return;
          if (!aliasNames.has(id.name)) return;
          if ((refCounts.get(id.name) ?? 0) === 0) dead.push(path);
        },
      });
      for (const d of dead) {
        if (!d.node) continue;
        const nm = ((d.node as t.VariableDeclarator).id as t.Identifier).name;
        d.remove();
        aliasNames.delete(nm);
        removedAny = true;
      }
      if (!removedAny) break;
    }

    // ---------- 5b) 清理无引用的包装函数（不动点） ----------
    const wrapperNames = new Set(wrappers.keys());
    for (let iter = 0; iter < 6 && wrapperNames.size > 0; iter++) {
      const refCounts = new Map<string, number>();
      traverse(ast, {
        ReferencedIdentifier(path) {
          if (wrapperNames.has(path.node.name)) {
            refCounts.set(path.node.name, (refCounts.get(path.node.name) ?? 0) + 1);
          }
        },
      });
      const dead: Array<import('@babel/traverse').NodePath<t.FunctionDeclaration>> = [];
      traverse(ast, {
        FunctionDeclaration(path) {
          const nm = path.node.id?.name;
          if (!nm || !wrapperNames.has(nm)) return;
          if ((refCounts.get(nm) ?? 0) === 0) dead.push(path);
        },
      });
      if (dead.length === 0) break;
      for (const d of dead) {
        if (!d.node) continue;
        const nm = d.node.id?.name;
        d.remove();
        if (nm) wrapperNames.delete(nm);
      }
    }

    // ---------- 6) prologue 移除判定 ----------
    // prologue 函数体/轮转 IIFE 之外的引用必须为 0。
    // 注意：存活的 wrapper/别名对 decoder 的引用【必须计数】——它们有真实调用点
    // （如非字面量实参），依赖链尚存，删 decoder 即 ReferenceError。
    let outsideRefs = 0;
    traverse(ast, {
      ReferencedIdentifier(path) {
        if (!prologueNames.has(path.node.name)) return;
        let p: import('@babel/traverse').NodePath | null = path.parentPath;
        while (p) {
          const n = p.node;
          if (t.isFunctionDeclaration(n) && n.id && prologueNames.has(n.id.name)) return;
          if (t.isExpressionStatement(n) && isPoolRotatorStatement(n, prologueNames)) return;
          p = p.parentPath;
        }
        outsideRefs++;
      },
    });

    const notes = [
      `inlined=${replaced}/${reqs.length}`,
      failed > 0 ? `eval-failed=${failed}` : '',
      `outside-refs=${outsideRefs}`,
      `aliases=${aliasNames.size}`,
    ].filter(Boolean);

    if (replaced > 0 && replaced === reqs.length && outsideRefs === 0) {
      traverse(ast, {
        'FunctionDeclaration|ExpressionStatement'(path) {
          const n = path.node;
          if (t.isFunctionDeclaration(n) && n.id && prologueNames.has(n.id.name)) {
            path.remove();
            return;
          }
          if (t.isExpressionStatement(n) && isPoolRotatorStatement(n, prologueNames)) {
            const expr = (path.node as t.ExpressionStatement).expression;
            if (t.isSequenceExpression(expr) && expr.expressions.length > 1) {
              const kept = expr.expressions.filter(
                (e) => !(t.isCallExpression(e) && (t.isFunctionExpression(e.callee) || t.isArrowFunctionExpression(e.callee))),
              );
              if (kept.length === 1) path.replaceWith(t.expressionStatement(kept[0]));
              else (path.node as t.ExpressionStatement).expression = t.sequenceExpression(kept);
            } else {
              path.remove();
            }
          }
        },
      });
      notes.push('prologue-removed');
    }

    return result(true, notes);
  },
};
