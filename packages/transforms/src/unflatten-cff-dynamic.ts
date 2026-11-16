/**
 * 动态控制流还原（执行序探针，"静态失败 → 运行时事实"的实例）：
 *
 * 静态 unflatten-cff 依赖顺序串可静态求值（'a|b|c'.split 或常量成员）。
 * 顺序串来自函数调用/计算时（自定义混淆器常见），静态失败 → 本变换接管：
 *
 *  1. 识别"truthy while + switch(seq[i++])"分发器（seq 声明不可静态求值）
 *  2. 全锚点采样 br trace（函数名过滤），goto 序列落在被命中 case 的行区间
 *     → case 命中序
 *  3. 保守条件：序列无相邻重复（无内层循环）、跨锚点完全一致
 *  4. 按命中序重排 case 块（恒等变换，锚库逐条验证）
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { printCode, traverse } from "@jsseal/ast";
import type { SealedFlags, SealedOutput, TraceEvent } from "@jsseal/runtime";
import { runSealed } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform, TransformContext } from "./types";

/** 匿名（无法从声明推出名字）函数在 trace/notes 里的占位名 */
const ANONYMOUS_FN_NAME = "(anonymous)";

const truthyLike = (test: t.Expression): boolean => {
  if (t.isBooleanLiteral(test)) {
    return test.value;
  }

  if (t.isUnaryExpression(test) && test.operator === "!") {
    const a = test.argument;

    if (
      t.isUnaryExpression(a) &&
      a.operator === "!" &&
      (t.isArrayExpression(a.argument) || t.isObjectExpression(a.argument))
    ) {
      return true;
    }
  }

  return false;
};

/** 对象属性的名字（非标识符/字符串键用占位名） */
const propertyKeyName = (key: t.Node): string => {
  if (t.isIdentifier(key)) {
    return key.name;
  }

  if (t.isStringLiteral(key)) {
    return key.value;
  }

  return ANONYMOUS_FN_NAME;
};

/** 函数名（含匿名 → '(anonymous)'） */
const enclosingFnName = (path: NodePath): string => {
  let p: NodePath | null = path;

  while (p !== null) {
    const n = p.node;

    if (t.isFunctionDeclaration(n) && n.id) {
      return n.id.name;
    }

    if (t.isFunctionExpression(n) || t.isArrowFunctionExpression(n)) {
      const parent = p.parentPath?.node;

      if (t.isVariableDeclarator(parent) && t.isIdentifier(parent.id)) {
        return parent.id.name;
      }

      if (t.isObjectProperty(parent)) {
        return propertyKeyName(parent.key);
      }

      return ANONYMOUS_FN_NAME;
    }

    p = p.parentPath;
  }

  return ANONYMOUS_FN_NAME;
};

interface Dispatcher {
  whilePath: NodePath<t.WhileStatement>;
  sw: t.SwitchStatement;
  seqName: string;
  fnName: string;
}

/** body 必须是 \{ switch, (break)? \} 或直接 switch */
const dispatcherSwitch = (node: t.WhileStatement): t.SwitchStatement | null => {
  const body: readonly t.Statement[] = t.isBlockStatement(node.body)
    ? node.body.body
    : [node.body];

  let sw: t.SwitchStatement | null = null;

  for (const stmt of body) {
    if (t.isSwitchStatement(stmt)) {
      sw = stmt;
      break;
    }
  }

  if (sw === null) {
    return null;
  }

  for (const stmt of body) {
    if (stmt !== sw && !t.isBreakStatement(stmt)) {
      return null;
    }
  }

  return sw;
};

/** discrim 形如 seq[i++] 时返回 seq 的名字（运算符种类由运行时事实决定，此处不限定） */
const seqNameOf = (sw: t.SwitchStatement): string | null => {
  const d = sw.discriminant;

  if (!t.isMemberExpression(d) || !d.computed || !t.isIdentifier(d.object)) {
    return null;
  }

  if (
    !t.isUpdateExpression(d.property) ||
    !t.isIdentifier(d.property.argument)
  ) {
    return null;
  }

  return d.object.name;
};

/** dp 是否是 seq 的静态可求值声明（'a|b'.split('|')） */
const isStaticSeqDecl = (
  dp: NodePath<t.VariableDeclarator>,
  seqName: string
): boolean => {
  const { id } = dp.node;

  if (!t.isIdentifier(id) || id.name !== seqName) {
    return false;
  }

  const { init } = dp.node;

  if (!init || !t.isCallExpression(init)) {
    return false;
  }

  const { callee } = init;

  if (
    !t.isMemberExpression(callee) ||
    !t.isIdentifier(callee.property) ||
    callee.property.name !== "split"
  ) {
    return false;
  }

  return t.isStringLiteral(callee.object);
};

const hasStaticSeqDeclIn = (scopeRoot: NodePath, seqName: string): boolean => {
  let found = false;

  const onVariableDeclarator = (dp: NodePath<t.VariableDeclarator>): void => {
    if (found) {
      return;
    }

    if (isStaticSeqDecl(dp, seqName)) {
      found = true;
    }
  };

  scopeRoot.traverse({ VariableDeclarator: onVariableDeclarator });

  return found;
};

/** 静态可解？（可静态求值则让静态版处理） */
const hasStaticSeqDecl = (
  path: NodePath<t.WhileStatement>,
  seqName: string
): boolean => {
  let p: NodePath | null = path.parentPath;

  while (p !== null) {
    if (hasStaticSeqDeclIn(p, seqName)) {
      return true;
    }

    p = p.parentPath;
  }

  return false;
};

/** 识别静态失败的分发器 */
const collectDispatchers = (ast: t.File): Dispatcher[] => {
  const dispatchers: Dispatcher[] = [];

  const onWhileStatement = (path: NodePath<t.WhileStatement>): void => {
    if (!truthyLike(path.node.test)) {
      return;
    }

    const sw = dispatcherSwitch(path.node);

    if (sw === null) {
      return;
    }

    const seqName = seqNameOf(sw);

    if (seqName === null) {
      return;
    }

    if (hasStaticSeqDecl(path, seqName)) {
      return;
    }

    dispatchers.push({
      whilePath: path,
      fnName: enclosingFnName(path),
      sw,
      seqName,
    });
  };

  traverse(ast, { WhileStatement: onWhileStatement });

  return dispatchers;
};

/** 无条件 goto 事件的行号（l 缺失则丢弃） */
const goLineOf = (event: TraceEvent): number | null => {
  if (event.k !== "go") {
    return null;
  }

  const { l } = event;

  return l ?? null;
};

/** 无条件 goto 的行号表（条件跳转不进命中序分析，只取 go） */
const goLinesOf = (events: readonly TraceEvent[]): number[] => {
  const lines: number[] = [];

  for (const event of events) {
    const line = goLineOf(event);

    if (line !== null) {
      lines.push(line);
    }
  }

  return lines;
};

/** switch 路径是否仍挂在 while 体内（替换后可能失效） */
const hasSwitchPath = (d: Dispatcher): boolean => {
  let found = false;

  const onSwitchStatement = (p: NodePath<t.SwitchStatement>): void => {
    if (p.node === d.sw && !found) {
      found = true;
    }
  };

  d.whilePath.traverse({ SwitchStatement: onSwitchStatement });

  return found;
};

interface CaseRange {
  key: string;
  from: number;
  to: number;
}

/** case 行区间表（首行到下一个 case 起点） */
const caseRangesOf = (sw: t.SwitchStatement, lines: number): CaseRange[] => {
  const ranges: CaseRange[] = [];

  for (const c of sw.cases) {
    if (c.test === null || c.test === undefined || !t.isStringLiteral(c.test)) {
      continue;
    }

    ranges.push({
      key: c.test.value,
      from: c.test.loc?.start.line ?? -1,
      to: lines + 1,
    });
  }

  ranges.sort((a, b) => a.from - b.from);

  for (let i = 0; i < ranges.length - 1; i += 1) {
    ranges[i].to = ranges[i + 1].from;
  }

  return ranges;
};

type OrderOutcome = { order: string[] } | { failure: string[] };

/** goto 序 → case 命中序（相邻去重校验 + 保守条件） */
const dispatcherOrder = (
  d: Dispatcher,
  brLines: readonly number[],
  lines: number
): OrderOutcome => {
  if (!hasSwitchPath(d)) {
    return { failure: ["switch path lost"] };
  }

  const caseRanges = caseRangesOf(d.sw, lines);

  // 循环体行范围（探测窗口）
  const loopFrom = d.whilePath.node.loc?.start.line ?? 1;
  const loopTo = d.whilePath.node.loc?.end.line ?? lines;
  const lineToCase = new Map<number, string>();

  for (const r of caseRanges) {
    for (let l = r.from; l < r.to; l += 1) {
      lineToCase.set(l, r.key);
    }
  }

  const seq: string[] = [];
  const raw: string[] = [];

  for (const l of brLines) {
    const c = l >= loopFrom && l <= loopTo ? lineToCase.get(l) : undefined;

    if (c === undefined) {
      continue;
    }

    raw.push(c);

    if (seq.length === 0 || seq.at(-1) !== c) {
      seq.push(c);
    }
  }

  if (raw.some((c, i) => i > 0 && raw[i - 1] === c)) {
    return {
      failure: [`dispatcher@${d.fnName}: 重复迭代（疑似内层循环），保守放弃`],
    };
  }

  if (seq.length !== caseRanges.length) {
    return {
      failure: [
        `dispatcher@${d.fnName}: 命中数(${seq.length}) != case 数(${caseRanges.length})，保守放弃`,
      ],
    };
  }

  return { order: seq };
};

/** 采样是否因确定性资源原因不可用（磁带耗尽/超时/内存超限） */
const flagsFaulted = (flags: SealedFlags): boolean =>
  flags.tapeExhausted === true || flags.timeout === true || flags.oom === true;

type SamplingOutcome = { orders: string[][] } | { failure: string[] };

/** 全锚点采样 case 命中序（跨锚点必须完全一致） */
const sampleOrders = async (
  ctx: TransformContext,
  dispatchers: readonly Dispatcher[],
  candidate: string,
  lines: number
): Promise<SamplingOutcome> => {
  let orders: string[][] | null = null;

  for (const sample of ctx.corpus?.samples ?? []) {
    let out: SealedOutput;

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- 锚点必须串行回放：native 引擎单实例，并发采样会互相污染 trace
      out = await runSealed({
        code: candidate,
        mode: "replay",
        tapes: sample.tapes,
        backend: "native",
        trace: { branches: true, cretFns: [dispatchers[0].fnName] },
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch {
      return { failure: ["probe fault"] };
    }

    if (flagsFaulted(out.flags)) {
      return { failure: [`probe fault: ${JSON.stringify(out.flags)}`] };
    }

    /* 只用无条件 goto（switch 查找表与 continue）——条件跳转会污染命中序分析 */
    const brLines = goLinesOf(out.trace?.events ?? []);

    if (out.trace?.truncated === true) {
      return { failure: ["probe trace truncated"] };
    }

    const thisOrders: string[][] = [];

    for (const d of dispatchers) {
      const outcome = dispatcherOrder(d, brLines, lines);

      if ("failure" in outcome) {
        return outcome;
      }

      thisOrders.push(outcome.order);
    }

    if (orders === null) {
      orders = thisOrders;
    } else if (JSON.stringify(orders) !== JSON.stringify(thisOrders)) {
      return { failure: ["跨锚点命中序不一致（输入依赖），保守放弃"] };
    }
  }

  if (orders === null) {
    return { failure: ["no corpus"] };
  }

  return { orders };
};

/** 按命中序重排单个分发器（false = case 结构不可重排，保守跳过） */
const applyOrder = (d: Dispatcher, order: readonly string[]): boolean => {
  const caseMap = new Map<string, t.Statement[]>();

  for (const c of d.sw.cases) {
    if (c.test === null || c.test === undefined || !t.isStringLiteral(c.test)) {
      return false;
    }

    const stmts = [...c.consequent];
    const last = stmts.at(-1);

    if (last !== undefined && t.isContinueStatement(last) && !last.label) {
      stmts.pop();
    }

    caseMap.set(c.test.value, stmts);
  }

  const out: t.Statement[] = [];

  for (const key of order) {
    const stmts = caseMap.get(key);

    if (stmts === undefined) {
      return false;
    }

    out.push(...stmts);
  }

  d.whilePath.replaceWith(t.blockStatement(out));

  return true;
};

export const unflattenCffDynamic: Transform = {
  name: "unflatten-cff-dynamic",
  // 运行时采样 + 结构重排（锚库验证把关）
  risk: "unsafe",
  async run(ast, ctx) {
    if (ctx.backend !== "native") {
      return result(false, ["native backend only"]);
    }

    if (!ctx.corpus || ctx.corpus.samples.length === 0) {
      return result(false, ["no corpus"]);
    }

    // 行号基准（beautified 当前码）
    const candidate = printCode(ast);
    const lines = candidate.split("\n").length;

    // ---------- 1) 识别静态失败的分发器 ----------
    const dispatchers = collectDispatchers(ast);

    if (dispatchers.length === 0) {
      return result(false, ["no dynamic dispatcher"]);
    }

    // ---------- 2) 全锚点采样 case 命中序 ----------
    const sampling = await sampleOrders(ctx, dispatchers, candidate, lines);

    if ("failure" in sampling) {
      return result(false, sampling.failure);
    }

    // ---------- 3) 重排 ----------
    const notes: string[] = [];
    let count = 0;

    for (const [di, d] of dispatchers.entries()) {
      const order = sampling.orders[di];

      if (applyOrder(d, order)) {
        count += 1;
        notes.push(`${d.fnName}:${order.join(">")}`);
      }
    }

    // 清理 seq/idx 声明（deferred：replaceWith 后路径失效，重新遍历删 declarator）
    // v1: 保留死变量（dead-code/fold 后续无害）
    return count > 0
      ? result(true, [`unflattened=${count}`, ...notes])
      : result(false, notes);
  },
};
