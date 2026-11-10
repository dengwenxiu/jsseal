/**
 * js-confuser 2.x stringConcealing（Base91 变体）还原：
 *
 * 形态（v2.1.3 实测）：
 *   function F(start, length) { return D(A["slice"](start, start + length)); }
 *   D = Base91 解码（table.indexOf + v+=p*91 位打包 → 字节 → TextDecoder UTF-8）
 *   A = 全局密文数组（字符串）；每个作用域可有独立 F/D，共享 A
 *
 * 调用点 F(start, length) 是纯函数（数字参数 → 字符串），与运行时状态无关 →
 * cret trace（白名单过滤）捕获 (args → v) 事实，按键回填字符串字面量。
 * 跨锚点一致才采信；污点条目（t，依赖种子）跳过——"感染即不可常量化"。
 *
 * 与旧 cff_xor（jsconfuser-unfold）是两代机制：xor 仍在 cff 选项中使用，
 * stringConcealing 选项单独使用 Base91。两者互不干扰。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';

/**
 * AST 形态检测：function F(s,l){ return D(ANY[sliceMethod](s, s+l)); }
 * 属性访问放宽到任意计算表达式——js-confuser preset（含 minify）会把
 * "slice" 方法名藏进常量表（A[tbl[k]]），但包装函数骨架不变。
 */
function detectStrFunctions(ast: t.File): string[] {
  const names: string[] = [];
  traverse(ast, {
    FunctionDeclaration(path) {
      const node = path.node;
      if (!node.id || node.params.length !== 2) return;
      const [ps, pl] = node.params;
      if (!t.isIdentifier(ps) || !t.isIdentifier(pl)) return;
      if (node.body.body.length !== 1) return;
      const stmt = node.body.body[0];
      if (!t.isReturnStatement(stmt) || !stmt.argument) return;
      const call = stmt.argument;
      if (!t.isCallExpression(call) || call.arguments.length !== 1) return;
      if (!t.isIdentifier(call.callee)) return;
      const arg = call.arguments[0];
      if (!t.isCallExpression(arg) || arg.arguments.length !== 2) return;
      const member = arg.callee;
      if (!t.isMemberExpression(member)) return;
      const [a0, a1] = arg.arguments;
      if (
        t.isIdentifier(a0, { name: ps.name }) &&
        t.isBinaryExpression(a1, { operator: '+' }) &&
        t.isIdentifier(a1.left, { name: ps.name }) &&
        t.isIdentifier(a1.right, { name: pl.name })
      ) {
        names.push(node.id.name);
      }
    },
  });
  return names;
}

/** 字面量数字参数（含一元负数） → number | null */
function numericLiteralOf(node: t.Expression): number | null {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isUnaryExpression(node, { operator: '-' }) && t.isNumericLiteral(node.argument)) return -node.argument.value;
  return null;
}

interface TraceEvent {
  k: string;
  fn?: string;
  a?: unknown[];
  v?: unknown;
  t?: number;
}

export const jsconfuserStrings: Transform = {
  name: 'jsconfuser-strings',
  risk: 'unsafe',
  async run(ast, ctx) {
    const strFns = detectStrFunctions(ast);
    if (strFns.length === 0) return result(false, ['no STR functions']);
    if (!ctx.corpus || ctx.corpus.samples.length === 0) return result(false, ['no corpus']);

    // ---------- 1) 多锚点 cret 事实采集 ----------
    const fnSet = new Set(strFns);
    const votes = new Map<string, Map<string, number>>(); // key -> v -> 票数
    let runs = 0;
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
          trace: { callArgs: true, cretFns: strFns },
        });
      } catch {
        continue;
      }
      if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) continue;
      runs++;
      for (const ev of (out.trace?.events ?? []) as TraceEvent[]) {
        if (ev.k !== 'cret' || !ev.fn || !fnSet.has(ev.fn)) continue;
        if (ev.t) continue; // 污点：调用子树消费过种子 → 不可常量化
        const [a0, a1] = ev.a ?? [];
        if (typeof a0 !== 'number' || typeof a1 !== 'number') continue;
        if (typeof ev.v !== 'string') continue;
        const key = `${ev.fn}|${a0}|${a1}`;
        const ballot = votes.get(key) ?? new Map<string, number>();
        ballot.set(ev.v, (ballot.get(ev.v) ?? 0) + 1);
        votes.set(key, ballot);
      }
    }
    if (runs === 0) return result(false, ['trace runs failed']);

    // ---------- 2) 一致事实 → 回填表（跨锚点冲突的键弃用） ----------
    const table = new Map<string, string>();
    let conflicts = 0;
    for (const [key, ballot] of votes) {
      if (ballot.size === 1) {
        table.set(key, [...ballot.keys()][0]);
      } else {
        conflicts++;
      }
    }

    // ---------- 3) 调用点回填（字面量参数按键匹配） ----------
    let replaced = 0;
    const paths: Array<{ path: import('@babel/traverse').NodePath<t.CallExpression>; v: string }> = [];
    traverse(ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee) || !fnSet.has(callee.name)) return;
        if (path.node.arguments.length !== 2) return;
        const a0 = numericLiteralOf(path.node.arguments[0] as t.Expression);
        const a1 = numericLiteralOf(path.node.arguments[1] as t.Expression);
        if (a0 === null || a1 === null) return;
        const v = table.get(`${callee.name}|${a0}|${a1}`);
        if (v === undefined) return;
        paths.push({ path, v });
      },
    });
    for (const { path, v } of paths) {
      try {
        path.replaceWith(t.stringLiteral(v));
        replaced++;
      } catch {
        /* skip */
      }
    }

    if (replaced === 0) return result(false, [`fns=${strFns.length} facts=${table.size} no literal sites`]);
    return result(true, [
      `fns=${strFns.length}`,
      `facts=${table.size}`,
      `inlined=${replaced}`,
      ...(conflicts > 0 ? [`conflicts=${conflicts}`] : []),
    ]);
  },
};
