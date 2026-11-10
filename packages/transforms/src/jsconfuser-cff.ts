/**
 * jsconfuser 状态机 CFF 还原：
 *
 * 形态：while(sum(states)!==终值){switch(sum(states)){case N:...}}
 *
 * 策略（纯字符串注入，避免 AST path 作用域问题）：
 *  1. 检测 while(sum()) 模式
 *  2. 在源码字符串中每个 case 前注入 push 调用（正则定位）
 *  3. 封闭运行时执行 → 拿到 case 命中序
 *  4. 按序输出每个命中 case 的非扰动语句
 */

import * as t from '@babel/types';
import { printCode, traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';

interface StateMachineInfo {
  whilePath: import('@babel/traverse').NodePath<t.WhileStatement>;
  sw: t.SwitchStatement;
  statesParam: string;
  sumFnName: string;
  caseCount: number;
}

function findStateMachine(ast: t.File): StateMachineInfo | null {
  let found: StateMachineInfo | null = null;
  traverse(ast, {
    WhileStatement(path) {
      if (found) return;
      const test = path.node.test;
      if (!t.isBinaryExpression(test) || test.operator !== '!==') return;
      if (!t.isCallExpression(test.left)) return;
      if (!t.isIdentifier(test.left.callee)) return;
      if (!test.left.callee.name.includes('cff_sum')) return;
      if (test.left.arguments.length !== 1 || !t.isIdentifier(test.left.arguments[0])) return;
      const body = path.node.body;
      const stmts = t.isBlockStatement(body) ? body.body : [body];
      const sw = stmts.find((s) => t.isSwitchStatement(s)) as t.SwitchStatement | undefined;
      if (!sw) return;
      found = {
        whilePath: path,
        sw,
        statesParam: (test.left.arguments[0] as t.Identifier).name,
        sumFnName: test.left.callee.name,
        caseCount: sw.cases.length,
      };
    },
  });
  return found;
}

/** 判断语句是否为纯状态扰动 */
function isPerturbation(stmt: t.Statement, statesParam: string): boolean {
  if (t.isReturnStatement(stmt)) return false; // return 永远是真实逻辑
  if (t.isBreakStatement(stmt) || t.isEmptyStatement(stmt)) return true;
  if (t.isExpressionStatement(stmt)) {
    const expr = stmt.expression;
    if (t.isAssignmentExpression(expr)) {
      const left = expr.left;
      if (t.isMemberExpression(left) && t.isIdentifier(left.object, { name: statesParam })) return true;
    }
    if (t.isSequenceExpression(expr)) {
      // 序列中只要有一项不是纯 states 扰动 → 整条不是扰动
      return expr.expressions.every((e) => {
        if (t.isAssignmentExpression(e)) {
          const left = e.left;
          if (t.isMemberExpression(left) && t.isIdentifier(left.object, { name: statesParam })) return true;
          // scope 赋值不是扰动（可能是 _return = true）
          if (t.isMemberExpression(left) && !t.isIdentifier(left.object)) return false;
          if (t.isIdentifier(left)) return true;
        }
        return false;
      });
    }
    return false;
  }
  if (t.isVariableDeclaration(stmt)) {
    return stmt.declarations.every((d) =>
      t.isIdentifier(d.id) && (d.id.name.includes('_return') || d.id.name.includes('_result')),
    );
  }
  if (t.isIfStatement(stmt)) {
    const check = (b: t.Statement | null): boolean => {
      if (!b) return true;
      const ss = t.isBlockStatement(b) ? b.body : [b];
      return ss.every((s) => isPerturbation(s, statesParam));
    };
    return check(stmt.consequent ?? null) && check(stmt.alternate ?? null);
  }
  return false;
}

/**
 * AST 级注入：在 Program 开头声明 orderVar，每个 case 体开头注入 push 调用。
 * 比 Regex 字符串注入可靠（Babel 重打印后格式不确定——实测教训）。
 */
function instrumentAst(ast: t.File, sm: StateMachineInfo, orderVarName: string): string {
  // 1) Program 开头声明
  ast.program.body.unshift(
    t.variableDeclaration('var', [
      t.variableDeclarator(t.identifier(orderVarName), t.arrayExpression([])),
    ]),
  );

  // 2) 每个 case 体开头注入 push
  sm.sw.cases.forEach((c, idx) => {
    const push = t.expressionStatement(
      t.callExpression(
        t.memberExpression(t.identifier(orderVarName), t.identifier('push')),
        [t.numericLiteral(idx)],
      ),
    );
    c.consequent.unshift(push);
  });

  // 3) 打印 + dump
  return printCode(ast) + `\nglobalThis.__jsseal_ret_raw = JSON.stringify(${orderVarName});`;
}

export const jsconfuserCff: Transform = {
  name: 'jsconfuser-cff',
  risk: 'unsafe',
  async run(ast, ctx) {
    const sm = findStateMachine(ast);
    if (!sm) return result(false, ['no state machine']);
    // js-confuser ≥2.1：case 标签是 states 派生表达式（如 case states[72]-92:），
    // case 值随扰动演化——静态假设失效。提前熔断避免每轮注入运行 + 锚库验证空转
    // （combo 实测曾单样本空转 100s+）。运行时命中序重建的适配列入 roadmap。
    const dynamicLabels = sm.sw.cases.some(
      (c) =>
        c.test !== null &&
        !t.isNumericLiteral(c.test) &&
        !(t.isUnaryExpression(c.test, { operator: '-' }) && t.isNumericLiteral(c.test.argument)),
    );
    if (dynamicLabels) return result(false, ['dynamic case labels (js-confuser >=2.1) unsupported']);

    // ---------- 1) 生成 instrumented 代码并执行 ----------
    if (!ctx.corpus || ctx.corpus.samples.length === 0) return result(false, ['no corpus']);
    const sample = ctx.corpus.samples[0];

    // 深拷贝 AST 避免污染（后续还要用原 AST 过滤）
    const astCopy = require('@jsseal/ast').parseCode(ctx.code);
    const smCopy = findStateMachine(astCopy as t.File);
    if (!smCopy) return result(false, ['state machine lost on copy']);
    const instrumented = instrumentAst(astCopy as t.File, smCopy, '___jssealCffOrd');
    let out;
    try {
      out = await runSealed({
        code: instrumented,
        mode: 'replay',
        tapes: sample.tapes,
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch (e) {
      return result(false, [`sim fault: ${(e as Error).message}`]);
    }
    if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) {
      return result(false, [`sim fault: ${JSON.stringify(out.flags)}`]);
    }
    let order: number[];
    try {
      order = JSON.parse(out.ret ?? '[]');
    } catch {
      return result(false, [`sim unparsable: ret=${(out.ret ?? 'null').slice(0, 80)}`]);
    }
    if (!Array.isArray(order) || order.length === 0) {
      return result(false, [`no order captured (len=${order?.length}, thrown=${(out.thrown ?? '').slice(0, 60)})`]);
    }

    // ---------- 2) 按序过滤扰动（含 fall-through 收集） ----------
    const collected: t.Statement[] = [];
    for (const entryIdx of order) {
      // fall-through：从入口 case 开始，收集直到 break/return 或 switch 结束
      for (let ci = entryIdx; ci < sm.sw.cases.length; ci++) {
        const c = sm.sw.cases[ci];
        if (!c) break;
        let hasTerminal = false; // break 或 return
        for (const stmt of c.consequent) {
          if (t.isBreakStatement(stmt)) { hasTerminal = true; continue; }
          if (t.isReturnStatement(stmt)) { hasTerminal = true; }
          if (isPerturbation(stmt, sm.statesParam)) continue;
          collected.push(t.cloneNode(stmt, true));
        }
        if (hasTerminal) break; // 不再 fall-through
      }
    }
    if (collected.length === 0) {
      return result(false, [`all ${order.length} cases perturbation-only`]);
    }

    // ---------- 3) 替换 while 循环 ----------
    sm.whilePath.replaceWith(t.blockStatement(collected));
    return result(true, [
      `cases=${order.length}`,
      `real=${collected.length}`,
      `order=[${order.slice(0, 8).join(',')}${order.length > 8 ? '...' : ''}]`,
    ]);
  },
};
