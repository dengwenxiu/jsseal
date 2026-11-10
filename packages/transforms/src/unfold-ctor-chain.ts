/**
 * Function 构造器链回填（JSFuck 路线的展开）：
 *
 * 形态 A（静态可识别，无需探针）：
 *   X["constructor"]("payload")()  →  payload 语句内联
 *   （X.constructor 即 Function 构造器；字符串字面量直接可回填）
 *
 * 形态 B（JSFuck 全编码）：
 *   语句 AST 子树内**不含任何 Identifier / StringLiteral / NumericLiteral**
 *   （方法名全部动态构造——字符集混淆的结构特征）→ 靠 evalLog 的
 *   '[Function] body' 事实按序对应回填。
 *
 * 两形态都要求"立即调用"语义（ctor(...)()）；赋值/传参形态 v1 跳过。
 */

import * as t from '@babel/types';
import { parseCode, traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';

/** X.constructor / X["constructor"] */
function isConstructorMember(node: t.MemberExpression): boolean {
  const prop = node.property;
  if (!node.computed && t.isIdentifier(prop) && prop.name === 'constructor') return true;
  if (node.computed && t.isStringLiteral(prop) && prop.value === 'constructor') return true;
  return false;
}

/** 形态 A：CallExpression{ callee: Call{ callee: X.constructor, args: [StringLiteral] }, args: [] } */
function matchStaticCtorCall(expr: t.Expression): string | null {
  if (!t.isCallExpression(expr) || expr.arguments.length !== 0) return null;
  const inner = expr.callee;
  if (!t.isCallExpression(inner) || inner.arguments.length !== 1) return null;
  if (!t.isMemberExpression(inner.callee) || !isConstructorMember(inner.callee)) return null;
  const body = inner.arguments[0];
  if (!t.isStringLiteral(body)) return null;
  return body.value;
}

/** 形态 B 判定：子树内不含任何字面内容节点（JSFuck 全编码的结构特征） */
function isOpaqueCharsetStatement(node: t.Node): boolean {
  let opaque = true;
  const walk = (n: t.Node): void => {
    if (!opaque || !n || typeof n !== 'object') return;
    if (t.isIdentifier(n) || t.isStringLiteral(n) || t.isNumericLiteral(n)) {
      opaque = false;
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const v = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && walk(c as t.Node));
      else if (v && typeof v === 'object' && 'type' in (v as object)) walk(v as t.Node);
    }
  };
  walk(node);
  return opaque;
}

/** 构造可解析的语句列表（不可解析返回 null） */
function parseStatements(src: string): t.Statement[] | null {
  try {
    const parsed = parseCode(src);
    const stmts = parsed.program.body;
    return stmts.length > 0 ? stmts.map((st) => t.cloneNode(st, true)) : null;
  } catch {
    return null;
  }
}

export const unfoldCtorChain: Transform = {
  name: 'unfold-ctor-chain',
  risk: 'unsafe',
  async run(ast, ctx) {
    const notes: string[] = [];
    const staticJobs: Array<{ path: import('@babel/traverse').NodePath<t.ExpressionStatement>; stmts: t.Statement[] }> = [];
    const charsetSites: Array<import('@babel/traverse').NodePath<t.ExpressionStatement>> = [];

    traverse(ast, {
      ExpressionStatement(path) {
        const expr = path.node.expression;
        const staticBody = matchStaticCtorCall(expr);
        if (staticBody !== null) {
          const stmts = parseStatements(staticBody);
          if (stmts) staticJobs.push({ path, stmts });
          return;
        }
        // 形态 B：不含字面内容的调用语句（JSFuck 全编码）
        if (t.isCallExpression(expr) && isOpaqueCharsetStatement(expr)) {
          charsetSites.push(path);
        }
      },
    });

    // ---------- 形态 A：静态回填 ----------
    let staticReplaced = 0;
    for (const job of staticJobs) {
      try {
        job.path.replaceWithMultiple(job.stmts);
        staticReplaced++;
      } catch {
        /* skip */
      }
    }
    if (staticReplaced > 0) notes.push(`static=${staticReplaced}`);

    // ---------- 形态 B：evalLog 事实按序回填 ----------
    let charsetReplaced = 0;
    if (charsetSites.length > 0 && ctx.corpus && ctx.corpus.samples.length > 0) {
      const logs: string[][] = [];
      for (const sample of ctx.corpus.samples) {
        if (sample.forceIndex !== undefined) continue;
        let out;
        try {
          out = await runSealed({
            code: ctx.code,
            mode: 'replay',
            tapes: sample.tapes,
            entry: ctx.corpus.entry,
            backend: ctx.corpus.backend,
            timeoutMs: ctx.timeoutMs,
            memoryLimitBytes: ctx.memoryLimitBytes,
          });
        } catch {
          logs.length = 0;
          break;
        }
        if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) {
          logs.length = 0;
          break;
        }
        logs.push((out.evalLog ?? []).filter((e) => e.startsWith('[Function] ')));
      }
      if (logs.length > 0) {
        const first = JSON.stringify(logs[0]);
        if (logs.every((l) => JSON.stringify(l) === first)) {
          const bodies = logs[0].map((e) => e.slice('[Function] '.length));
          if (bodies.length >= charsetSites.length) {
            for (let i = 0; i < charsetSites.length; i++) {
              const stmts = parseStatements(bodies[i]);
              if (!stmts) break;
              try {
                charsetSites[i].replaceWithMultiple(stmts);
                charsetReplaced++;
              } catch {
                break;
              }
            }
          } else {
            notes.push(`fn-entries ${bodies.length} < charset-sites ${charsetSites.length}`);
          }
        } else {
          notes.push('fn-evalLog varies');
        }
      }
      if (charsetReplaced > 0) notes.push(`charset=${charsetReplaced}`);
    }

    const replaced = staticReplaced + charsetReplaced;
    return replaced > 0 ? result(true, notes) : result(false, [...notes, 'no ctor-chain sites']);
  },
};
