/**
 * jsconfuser 状态机 CFF 还原：
 *
 * 形态：`while(sum(states)!==终值){switch(sum(states)){case N:...}}`
 *
 * 策略（纯字符串注入，避免 AST path 作用域问题）：
 *  1. 检测 while(sum()) 模式
 *  2. 在源码字符串中每个 case 前注入 push 调用（正则定位）
 *  3. 封闭运行时执行 → 拿到 case 命中序
 *  4. 按序输出每个命中 case 的非扰动语句
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { printCode, traverse, parseCode } from "@jsseal/ast";
import { runSealed } from "@jsseal/runtime";
import type { SealedOutput, SeedTapes } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform, TransformContext } from "./types";

interface StateMachineInfo {
  whilePath: NodePath<t.WhileStatement>;
  sw: t.SwitchStatement;
  statesParam: string;
  sumFnName: string;
  caseCount: number;
}

/** 命中序采集结果：order 与 fault 互斥 */
type CaseOrderCapture =
  | { order: number[]; fault?: undefined }
  | { order?: undefined; fault: string };

/** dump 的 JSON 元素只能是非负整数（引擎侧 push 的都是 case 下标字面量） */
const isCaseIndex = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** 锚点执行是否正常结束（磁带耗尽 / 超时 / 内存超限 → 输出不可信） */
const isUsableAnchor = (out: SealedOutput): boolean =>
  out.flags.tapeExhausted !== true &&
  out.flags.timeout !== true &&
  out.flags.oom !== true;

/** 命中序 dump 解析：非法 JSON 交给调用方按"不可解析"处理；非 case 下标数组返回 null */
const parseCaseOrder = (ret: string | undefined): number[] | null => {
  const decoded: unknown = JSON.parse(ret ?? "[]");
  const list: unknown[] = Array.isArray(decoded) ? decoded : [];

  if (!list.every(isCaseIndex)) {
    return null;
  }

  return list;
};

const findStateMachine = (ast: t.File): StateMachineInfo | null => {
  let found: StateMachineInfo | null = null;

  const visitWhileStatement = (path: NodePath<t.WhileStatement>): void => {
    if (found) {
      return;
    }

    const { test } = path.node;

    if (!t.isBinaryExpression(test) || test.operator !== "!==") {
      return;
    }

    if (!t.isCallExpression(test.left)) {
      return;
    }

    if (!t.isIdentifier(test.left.callee)) {
      return;
    }

    if (!test.left.callee.name.includes("cff_sum")) {
      return;
    }

    if (
      test.left.arguments.length !== 1 ||
      !t.isIdentifier(test.left.arguments[0])
    ) {
      return;
    }

    const { body } = path.node;
    const stmts = t.isBlockStatement(body) ? body.body : [body];
    const sw = stmts.find((s) => t.isSwitchStatement(s));

    if (!sw) {
      return;
    }

    found = {
      sw,
      whilePath: path,
      statesParam: test.left.arguments[0].name,
      sumFnName: test.left.callee.name,
      caseCount: sw.cases.length,
    };
  };

  traverse(ast, { WhileStatement: visitWhileStatement });

  return found;
};

/** 判断语句是否为纯状态扰动 */
const isPerturbation = (stmt: t.Statement, statesParam: string): boolean => {
  // return 永远是真实逻辑
  if (t.isReturnStatement(stmt)) {
    return false;
  }

  if (t.isBreakStatement(stmt) || t.isEmptyStatement(stmt)) {
    return true;
  }

  if (t.isExpressionStatement(stmt)) {
    const expr = stmt.expression;

    if (t.isAssignmentExpression(expr)) {
      const { left } = expr;

      if (
        t.isMemberExpression(left) &&
        t.isIdentifier(left.object, { name: statesParam })
      ) {
        return true;
      }
    }

    if (t.isSequenceExpression(expr)) {
      // 序列中只要有一项不是纯 states 扰动 → 整条不是扰动
      return expr.expressions.every((e) => {
        if (t.isAssignmentExpression(e)) {
          const { left } = e;

          if (
            t.isMemberExpression(left) &&
            t.isIdentifier(left.object, { name: statesParam })
          ) {
            return true;
          }

          // scope 赋值不是扰动（可能是 _return = true）
          if (t.isMemberExpression(left) && !t.isIdentifier(left.object)) {
            return false;
          }

          if (t.isIdentifier(left)) {
            return true;
          }
        }

        return false;
      });
    }

    return false;
  }

  if (t.isVariableDeclaration(stmt)) {
    return stmt.declarations.every(
      (d) =>
        t.isIdentifier(d.id) &&
        (d.id.name.includes("_return") || d.id.name.includes("_result"))
    );
  }

  if (t.isIfStatement(stmt)) {
    const check = (b: t.Statement | null): boolean => {
      if (!b) {
        return true;
      }

      const ss = t.isBlockStatement(b) ? b.body : [b];

      return ss.every((s) => isPerturbation(s, statesParam));
    };

    return check(stmt.consequent ?? null) && check(stmt.alternate ?? null);
  }

  return false;
};

/** js-confuser ≥2.1 的 case 标签是 states 派生表达式，静态假设失效 */
const hasDynamicCaseLabels = (sw: t.SwitchStatement): boolean =>
  sw.cases.some(
    (c) =>
      c.test !== null &&
      !t.isNumericLiteral(c.test) &&
      !(
        t.isUnaryExpression(c.test, { operator: "-" }) &&
        t.isNumericLiteral(c.test.argument)
      )
  );

/**
 * AST 级注入：在 Program 开头声明 orderVar，每个 case 体开头注入 push 调用。
 * 比 Regex 字符串注入可靠（Babel 重打印后格式不确定——实测教训）。
 */
const instrumentAst = (
  ast: t.File,
  sm: StateMachineInfo,
  orderVarName: string
): string => {
  // 1) Program 开头声明
  ast.program.body.unshift(
    t.variableDeclaration("var", [
      t.variableDeclarator(t.identifier(orderVarName), t.arrayExpression([])),
    ])
  );

  // 2) 每个 case 体开头注入 push
  for (const [idx, switchCase] of sm.sw.cases.entries()) {
    const push = t.expressionStatement(
      t.callExpression(
        t.memberExpression(t.identifier(orderVarName), t.identifier("push")),
        [t.numericLiteral(idx)]
      )
    );

    switchCase.consequent.unshift(push);
  }

  // 3) 打印 + dump
  return `${printCode(ast)}\nglobalThis.__jsseal_ret_raw = JSON.stringify(${orderVarName});`;
};

/**
 * 深拷贝 AST → 注入 → 封闭运行时执行，拿到运行时 case 命中序。
 * 拷贝避免污染原 AST（后续还要用原 AST 过滤）。
 */
const captureCaseOrder = async (
  ctx: TransformContext,
  tapes: SeedTapes
): Promise<CaseOrderCapture> => {
  const astCopy = parseCode(ctx.code);
  const smCopy = findStateMachine(astCopy);

  if (!smCopy) {
    return { fault: "state machine lost on copy" };
  }

  let out: SealedOutput;

  try {
    out = await runSealed({
      tapes,
      code: instrumentAst(astCopy, smCopy, "___jssealCffOrd"),
      mode: "replay",
      backend: ctx.backend,
      timeoutMs: ctx.timeoutMs,
      memoryLimitBytes: ctx.memoryLimitBytes,
    });
  } catch (error) {
    return {
      fault: `sim fault: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isUsableAnchor(out)) {
    return { fault: `sim fault: ${JSON.stringify(out.flags)}` };
  }

  let order: number[] | null;

  try {
    order = parseCaseOrder(out.ret);
  } catch {
    return { fault: `sim unparsable: ret=${(out.ret ?? "null").slice(0, 80)}` };
  }

  if (order === null || order.length === 0) {
    return {
      fault: `no order captured (len=${order?.length ?? "unparsed"}, thrown=${(out.thrown ?? "").slice(0, 60)})`,
    };
  }

  return { order };
};

/**
 * 单 case 体过滤：扰动语句丢弃，真实逻辑追加进 collected；
 * 返回是否遇到终结语句（break/return）。
 */
const collectCaseBody = (
  switchCase: t.SwitchCase,
  statesParam: string,
  collected: t.Statement[]
): boolean => {
  let hasTerminal = false;

  for (const stmt of switchCase.consequent) {
    if (t.isBreakStatement(stmt)) {
      hasTerminal = true;
      continue;
    }

    if (t.isReturnStatement(stmt)) {
      hasTerminal = true;
    }

    if (!isPerturbation(stmt, statesParam)) {
      collected.push(t.cloneNode(stmt, true));
    }
  }

  return hasTerminal;
};

/**
 * 按命中序收集真实逻辑（含 fall-through）：从入口 case 开始，
 * 收集直到 break/return 或 switch 结束。
 */
const collectCaseStatements = (
  sm: StateMachineInfo,
  order: number[]
): t.Statement[] => {
  const collected: t.Statement[] = [];

  for (const entryIdx of order) {
    for (const switchCase of sm.sw.cases.slice(entryIdx)) {
      // 终结语句之后不再 fall-through
      if (collectCaseBody(switchCase, sm.statesParam, collected)) {
        break;
      }
    }
  }

  return collected;
};

export const jsconfuserCff: Transform = {
  name: "jsconfuser-cff",
  risk: "unsafe",
  async run(ast, ctx) {
    const sm = findStateMachine(ast);

    if (!sm) {
      return result(false, ["no state machine"]);
    }

    // js-confuser ≥2.1：case 标签是 states 派生表达式（如 case states[72]-92:），
    // case 值随扰动演化——静态假设失效。提前熔断避免每轮注入运行 + 锚库验证空转
    // （combo 实测曾单样本空转 100s+）。运行时命中序重建的适配列入 roadmap。
    if (hasDynamicCaseLabels(sm.sw)) {
      return result(false, [
        "dynamic case labels (js-confuser >=2.1) unsupported",
      ]);
    }

    const samples = ctx.corpus?.samples ?? [];

    if (samples.length === 0) {
      return result(false, ["no corpus"]);
    }

    const [sample] = samples;

    // ---------- 1) 生成 instrumented 代码并执行 ----------
    const capture = await captureCaseOrder(ctx, sample.tapes);

    if (capture.fault !== undefined) {
      return result(false, [capture.fault]);
    }

    // ---------- 2) 按序过滤扰动（含 fall-through 收集） ----------
    const collected = collectCaseStatements(sm, capture.order);

    if (collected.length === 0) {
      return result(false, [
        `all ${capture.order.length} cases perturbation-only`,
      ]);
    }

    // ---------- 3) 替换 while 循环 ----------
    sm.whilePath.replaceWith(t.blockStatement(collected));

    return result(true, [
      `cases=${capture.order.length}`,
      `real=${collected.length}`,
      `order=[${capture.order.slice(0, 8).join(",")}${capture.order.length > 8 ? "..." : ""}]`,
    ]);
  },
};
