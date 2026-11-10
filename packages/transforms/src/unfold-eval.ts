/**
 * eval 展开（packer/jjencode/aaencode 等 eval 系家族的统一解法）：
 *
 *  1. 全锚点采样 evalLog（prelude 拦截 pass-through 记录的生成代码）
 *  2. 一致性：所有普通锚点的 evalLog 完全一致（强制锚点跳过——路径不同）
 *  3. AST 收集 `eval(<单参>)` 整语句调用点，数量必须与 evalLog 一一对应
 *  4. 每个调用点替换为对应生成代码的解析语句（内联处 var 提升语义与 direct eval 一致）
 *
 * 动态产生事实（evalLog）、静态执行改写（内联展开）、锚库逐条验证。
 */

import * as t from '@babel/types';
import { parseCode, traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';

export const unfoldEval: Transform = {
  name: 'unfold-eval',
  risk: 'unsafe', // 内联展开（锚库验证把关）
  async run(ast, ctx) {
    if (!ctx.corpus || ctx.corpus.samples.length === 0) return result(false, ['no corpus']);

    // ---------- 1) 全锚点采样 evalLog ----------
    const logs: string[][] = [];
    for (const sample of ctx.corpus.samples) {
      if (sample.forceIndex !== undefined) continue; // 强制锚点走不同路径
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
        return result(false, ['probe fault']);
      }
      if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) {
        return result(false, [`probe fault: ${JSON.stringify(out.flags)}`]);
      }
      logs.push(out.evalLog ?? []);
    }
    if (logs.length === 0) return result(false, ['no normal anchors']);
    const first = JSON.stringify(logs[0]);
    if (!logs.every((l) => JSON.stringify(l) === first)) {
      return result(false, [`evalLog varies across anchors (${logs.map((l) => l.length).join(',')} entries)`]);
    }
    const entries = logs[0];
    if (entries.length === 0) return result(false, ['no eval calls']);

    // Function 构造器条目（v1 只记录不展开）
    const fnEntries = entries.filter((e) => e.startsWith('[Function] '));
    const evalEntries = entries.filter((e) => !e.startsWith('[Function] '));

    // ---------- 2) 收集调用点 ----------
    const sites: Array<import('@babel/traverse').NodePath<t.ExpressionStatement>> = [];
    traverse(ast, {
      ExpressionStatement(path) {
        const e = path.node.expression;
        if (t.isCallExpression(e) && t.isIdentifier(e.callee, { name: 'eval' }) && e.arguments.length === 1) {
          sites.push(path);
        }
      },
    });
    if (sites.length === 0) return result(false, [`${evalEntries.length} eval entries but 0 call sites`]);
    // 条目可多于调用点（嵌套 eval：内层 eval 的参数也进 log）——调用点按序对应前 N 条，
    // 多余条目属于展开后的内层（下一轮处理）；条目少于调用点 = 条件 eval，保守放弃
    if (evalEntries.length < sites.length) {
      return result(false, [`eval entries ${evalEntries.length} < call sites ${sites.length}（条件 eval，保守放弃）`]);
    }

    // ---------- 3) 顺序对应展开 ----------
    // 假设：顶层语句的执行序与源码序一致（packer 等形态成立；锚库验证兜底）
    const notes: string[] = [];
    let replaced = 0;
    for (let i = 0; i < sites.length; i++) {
      const src = evalEntries[i];
      if (src === undefined) break;
      let parsed: t.File;
      try {
        parsed = parseCode(src);
      } catch {
        return result(false, [`entry#${i} unparsable`]);
      }
      const stmts = parsed.program.body;
      if (stmts.length === 0) continue;
      try {
        sites[i].replaceWithMultiple(stmts.map((st) => t.cloneNode(st, true)));
        replaced++;
      } catch {
        /* skip */
      }
    }
    if (fnEntries.length > 0) notes.push(`function-ctor-recorded=${fnEntries.length}`);
    return replaced > 0 ? result(true, [`unfolded=${replaced}`, ...notes]) : result(false, [...notes]);
  },
};
