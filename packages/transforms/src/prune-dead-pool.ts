/**
 * 死池修剪（sojson v7 教训：5501 条池占产物 98%，实际只用 1 条）：
 *
 * 前提：freeze-string-array 已固化池 + inline-decoder 已内联全部字面量调用。
 * 当代码中不再有活跃的解码器调用时，池 + 解码器 + 关联副作用语句全部是死代码。
 *
 * 策略：
 *  1. 检测解码器函数（detection plan）在当前代码中是否还有活跃调用（有实参的 CallExpression）
 *  2. 若无：移除 池函数 / 解码器函数（含 fallback/查找表） / `poolFn && (...)` 副作用
 *  3. 若有少量：仅保留被引用的池条目，其余删除
 */

import * as t from '@babel/types';
import { printCode, traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';

export const pruneDeadPool: Transform = {
  name: 'prune-dead-pool',
  risk: 'unsafe', // 删除函数/语句（锚库验证把关）
  async run(ast, ctx) {
    const plan = ctx.detection.obfuscatorIO;
    if (!plan || plan.stringArrayNames.length === 0) return result(false, ['no plan']);

    const poolNames = new Set(plan.stringArrayNames);
    const decoderNames = new Set(plan.decoderNames);
    // 别名
    traverse(ast, {
      VariableDeclarator(p) {
        if (t.isIdentifier(p.node.id) && t.isIdentifier(p.node.init)) {
          if (decoderNames.has(p.node.init.name)) decoderNames.add(p.node.id.name);
          if (poolNames.has(p.node.init.name)) poolNames.add(p.node.id.name);
        }
      },
    });

    // ---------- 1) 检测活跃的解码器调用 ----------
    let activeCalls = 0;
    const activeCallSites: Array<import('@babel/traverse').NodePath<t.CallExpression>> = [];
    traverse(ast, {
      CallExpression(path) {
        if (!t.isIdentifier(path.node.callee)) return;
        if (!decoderNames.has(path.node.callee.name)) return;
        // 排除自引用（递归 fallback 内部调用不算活跃）
        let inDecoderDef = false;
        let p: import('@babel/traverse').NodePath | null = path.parentPath;
        while (p) {
          const n = p.node;
          if (t.isFunctionDeclaration(n) && n.id && decoderNames.has(n.id.name)) {
            inDecoderDef = true;
            break;
          }
          p = p.parentPath;
        }
        if (inDecoderDef) return;
        activeCalls++;
        activeCallSites.push(path);
      },
    });

    // ---------- 2A) 无活跃调用 → 全部移除 ----------
    if (activeCalls === 0) {
      let removed = 0;
      traverse(ast, {
        'FunctionDeclaration|ExpressionStatement|VariableDeclaration'(path) {
          const n = path.node;
          // 池函数 / 解码器函数
          if (t.isFunctionDeclaration(n) && n.id && (poolNames.has(n.id.name) || decoderNames.has(n.id.name))) {
            path.remove();
            removed++;
            return;
          }
          // `poolFn && (...)` / `decoderFn && (...)` 副作用
          if (t.isExpressionStatement(n)) {
            const expr = n.expression;
            if (t.isLogicalExpression(expr) && expr.operator === '&&' && t.isIdentifier(expr.left)) {
              if (poolNames.has(expr.left.name) || decoderNames.has(expr.left.name)) {
                path.remove();
                removed++;
                return;
              }
            }
          }
          // `var alias = decoderName` 别名声明
          if (t.isVariableDeclaration(n)) {
            const all = n.declarations.every(
              (d) =>
                t.isIdentifier(d.id) &&
                d.init &&
                t.isIdentifier(d.init) &&
                (decoderNames.has(d.init.name) || poolNames.has(d.init.name)),
            );
            if (all && n.declarations.length > 0) {
              path.remove();
              removed++;
              return;
            }
          }
        },
      });
      return removed > 0
        ? result(true, [`removed=${removed}`, 'all-decoder-calls-inlined'])
        : result(false, ['nothing to prune']);
    }

    // ---------- 2B) 有活跃调用 → 尝试内联后移除 ----------
    if (activeCalls > 0 && activeCalls <= 20 && plan.prologueSource) {
      // 用 prologueSource 求值所有活跃调用，然后内联
      const reqs = activeCallSites.map((p) => {
        const args = p.node.arguments.map((a) =>
          t.isStringLiteral(a) || t.isNumericLiteral(a) ? (a as t.StringLiteral | t.NumericLiteral).value : undefined,
        );
        return { name: (p.node.callee as t.Identifier).name, args };
      });

      // 全部参数必须是字面量
      if (reqs.every((r) => r.args.every((a) => a !== undefined))) {
        const driver = `
var __out = [];
var __reqs = ${JSON.stringify(reqs)};
for (var __i = 0; __i < __reqs.length; __i++) {
  try {
    __out[__i] = { ok: true, v: globalThis[__reqs[__i].name].apply(null, __reqs[__i].args) };
  } catch (e) {
    __out[__i] = { ok: false };
  }
}
globalThis.__jsseal_ret_raw = JSON.stringify(__out);
`;
        try {
          const out = await runSealed({
            code: plan.prologueSource + '\n' + driver,
            mode: 'record',
            backend: ctx.backend,
            timeoutMs: ctx.timeoutMs,
            memoryLimitBytes: ctx.memoryLimitBytes,
          });
          if (!out.flags.tapeExhausted && !out.flags.timeout && !out.flags.oom) {
            const values = JSON.parse(out.ret ?? '[]');
            let inlined = 0;
            for (let i = 0; i < activeCallSites.length; i++) {
              const v = values[i];
              if (v?.ok && typeof v.v === 'string') {
                activeCallSites[i].replaceWith(t.stringLiteral(v.v));
                inlined++;
              }
            }
            if (inlined === activeCalls) {
              // 全部内联成功 → 递归调用自身移除（下一轮 governor 会再跑）
              return result(true, [`inlined-remaining=${inlined}`, 'next-round-will-prune']);
            }
          }
        } catch {
          /* eval 失败，保守跳过 */
        }
      }
    }

    return result(false, [`active-calls=${activeCalls}`, 'cannot-prune-yet']);
  },
};
