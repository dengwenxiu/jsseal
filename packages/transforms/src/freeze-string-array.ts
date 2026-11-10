/**
 * 字符串池终态固化（恒等变换）：
 *
 *  1. 封闭运行时执行三件套 prologue（含 rotate），读出 rotate 完成后的池终态
 *  2. 字符串数组函数替换为"返回终态字面量数组"（保持缓存引用形状）
 *  3. 删除轮转 IIFE
 *
 * 语义：rotate 的唯一可观测效应是池重排（与 decoder 的惰性初始化——后者保留在
 * decoder 原体中）→ 固化后行为不变（锚库验证）。价值：decoder 从"洗牌期时变"
 * 变为无状态，解锁 decoder-lookup-table；移除洗牌噪声。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { isPoolRotatorStatement } from '@jsseal/detector';
import { result, type Transform } from './types';

export const freezeStringArray: Transform = {
  name: 'freeze-string-array',
  risk: 'unsafe', // 执行求值（封闭运行时）+ 结构替换（锚库验证把关）
  async run(ast, ctx) {
    const plan = ctx.detection.obfuscatorIO;
    if (!plan || plan.stringArrayNames.length === 0 || !plan.prologueSource) {
      return result(false, ['no plan']);
    }
    const arrName = plan.stringArrayNames[0];

    // ---------- 1) 求出 rotate 后的池终态 ----------
    const driver = `
globalThis.__jsseal_ret_raw = JSON.stringify(typeof ${arrName} === 'function' ? ${arrName}() : null);
`;
    let out;
    try {
      out = await runSealed({
        code: plan.prologueSource + '\n' + driver,
        mode: 'record',
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch (e) {
      return result(false, [`pool eval fault: ${(e as Error).message}`]);
    }
    if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) {
      return result(false, [`pool eval fault: ${JSON.stringify(out.flags)}`]);
    }
    const seeds = out.consumed.random + out.consumed.date + out.consumed.time + out.consumed.crypto;
    if (seeds > 0) return result(false, [`pool eval consumed ${seeds} seeds — refuse`]);
    let pool: unknown;
    try {
      pool = JSON.parse(out.ret ?? 'null');
    } catch {
      return result(false, ['pool eval unparsable']);
    }
    if (!Array.isArray(pool) || pool.length === 0 || !pool.every((x) => typeof x === 'string')) {
      return result(false, [`pool shape invalid (len=${Array.isArray(pool) ? pool.length : -1})`]);
    }

    // ---------- 2) 替换字符串数组函数体（保持缓存引用形状） ----------
    let replacedFn = false;
    traverse(ast, {
      FunctionDeclaration(path) {
        const name = path.node.id?.name;
        if (name !== arrName) return;
        const cached = path.scope.generateUidIdentifier('frozen');
        const newArr = t.arrayExpression(pool.map((x) => t.stringLiteral(x as string)));
        path.replaceWith(
          t.functionDeclaration(
            t.identifier(name),
            [],
            t.blockStatement([
              t.variableDeclaration('var', [t.variableDeclarator(cached, newArr)]),
              t.expressionStatement(
                t.assignmentExpression(
                  '=',
                  t.identifier(name),
                  t.functionExpression(null, [], t.blockStatement([t.returnStatement(t.identifier(cached.name))])),
                ),
              ),
              t.returnStatement(t.callExpression(t.identifier(name), [])),
            ]),
          ),
        );
        replacedFn = true;
        path.skip(); /* 防止 visitor 命中自身替换产物（同名函数）导致无限递归 */
      },
    });

    // ---------- 3) 删除池变换器（通用：经典 rotate / sojson for+reverse 等） ----------
    let removedRotate = 0;
    const poolNameSet = new Set(plan.stringArrayNames);
    traverse(ast, {
      ExpressionStatement(path) {
        if (isPoolRotatorStatement(path.node, poolNameSet)) {
          /* 序列表达式包裹时只删 IIFE 元素（保留同语句其他副作用，如 version_ 重绑） */
          const expr = path.node.expression;
          if (t.isSequenceExpression(expr) && expr.expressions.length > 1) {
            const kept = expr.expressions.filter(
              (e) => !(t.isCallExpression(e) && (t.isFunctionExpression(e.callee) || t.isArrowFunctionExpression(e.callee))),
            );
            if (kept.length === 1) path.replaceWith(t.expressionStatement(kept[0]));
            else path.node.expression = t.sequenceExpression(kept);
          } else {
            path.remove();
          }
          removedRotate++;
        }
      },
    });

    if (!replacedFn && removedRotate === 0) return result(false, ['nothing to freeze']);
    return result(true, [
      `pool=${pool.length}`,
      `rotate-removed=${removedRotate}`,
      replacedFn ? 'array-fn-frozen' : 'array-fn-missing',
    ]);
  },
};
