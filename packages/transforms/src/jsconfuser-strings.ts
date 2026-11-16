/**
 * js-confuser 2.x stringConcealing（Base91 变体）还原：
 *
 * 形态（v2.1.3 实测）：
 *   `function F(start, length) { return D(A["slice"](start, start + length)); }`
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

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { AnchorSample, Corpus } from "@jsseal/anchors";
import { traverse } from "@jsseal/ast";
import { runSealed } from "@jsseal/runtime";
import type { SealedOutput, TraceEvent } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform, TransformContext } from "./types";

/** 多锚点投票结果：key → 候选值 → 票数，以及有效锚点数 */
interface VoteTally {
  votes: Map<string, Map<string, number>>;
  runs: number;
}

/** 一致事实表 + 跨锚点冲突键数 */
interface FactTable {
  table: Map<string, string>;
  conflicts: number;
}

/** 可回填的调用点 */
interface StringSite {
  path: NodePath<t.CallExpression>;
  v: string;
}

/** 引擎 dump 的事件字段只能运行时判定（JSON 边界） */
const isNumberValue = (value: unknown): value is number =>
  typeof value === "number";

const isStringValue = (value: unknown): value is string =>
  typeof value === "string";

/**
 * AST 形态检测：`function F(s,l){ return D(ANY[sliceMethod](s, s+l)); }`
 * 属性访问放宽到任意计算表达式——js-confuser preset（含 minify）会把
 * "slice" 方法名藏进常量表（A[tbl[k]]），但包装函数骨架不变。
 */
const detectStrFunctions = (ast: t.File): string[] => {
  const names: string[] = [];

  const visitFunctionDeclaration = (
    path: NodePath<t.FunctionDeclaration>
  ): void => {
    const { node } = path;

    if (!node.id || node.params.length !== 2) {
      return;
    }

    const [ps, pl] = node.params;

    if (!t.isIdentifier(ps) || !t.isIdentifier(pl)) {
      return;
    }

    if (node.body.body.length !== 1) {
      return;
    }

    const [stmt] = node.body.body;

    if (!t.isReturnStatement(stmt) || !stmt.argument) {
      return;
    }

    const call = stmt.argument;

    if (!t.isCallExpression(call) || call.arguments.length !== 1) {
      return;
    }

    if (!t.isIdentifier(call.callee)) {
      return;
    }

    const [arg] = call.arguments;

    if (!t.isCallExpression(arg) || arg.arguments.length !== 2) {
      return;
    }

    const member = arg.callee;

    if (!t.isMemberExpression(member)) {
      return;
    }

    const [a0, a1] = arg.arguments;

    if (
      t.isIdentifier(a0, { name: ps.name }) &&
      t.isBinaryExpression(a1, { operator: "+" }) &&
      t.isIdentifier(a1.left, { name: ps.name }) &&
      t.isIdentifier(a1.right, { name: pl.name })
    ) {
      names.push(node.id.name);
    }
  };

  traverse(ast, { FunctionDeclaration: visitFunctionDeclaration });

  return names;
};

/** 字面量数字参数（含一元负数） → number | null */
const numericLiteralOf = (node: t.Node | null | undefined): number | null => {
  if (t.isNumericLiteral(node)) {
    return node.value;
  }

  if (
    t.isUnaryExpression(node, { operator: "-" }) &&
    t.isNumericLiteral(node.argument)
  ) {
    return -node.argument.value;
  }

  return null;
};

/** 锚点执行是否正常结束（磁带耗尽/超时/内存超限 → 输出不可信） */
const isUsableAnchor = (out: SealedOutput): boolean =>
  out.flags.tapeExhausted !== true &&
  out.flags.timeout !== true &&
  out.flags.oom !== true;

/** 单锚点重放；null 表示该锚点不可用（forced 锚点 / 异常 / 执行未正常结束） */
const replayAnchor = async (
  ctx: TransformContext,
  corpus: Corpus,
  sample: AnchorSample,
  fnNames: string[]
): Promise<SealedOutput | null> => {
  if (sample.forceIndex !== undefined) {
    return null;
  }

  try {
    const out = await runSealed({
      tapes: sample.tapes,
      code: ctx.code,
      mode: "replay",
      entry: corpus.entry,
      backend: corpus.backend,
      timeoutMs: ctx.timeoutMs,
      memoryLimitBytes: ctx.memoryLimitBytes,
      trace: { callArgs: true, cretFns: fnNames },
    });

    return isUsableAnchor(out) ? out : null;
  } catch {
    return null;
  }
};

/** 单事件的投票：非 cret / 白名单外 / 污点 / 非原始参数一律丢弃 */
const tallyCretEvent = (
  event: TraceEvent,
  fnSet: Set<string>,
  votes: Map<string, Map<string, number>>
): void => {
  if (event.k !== "cret" || !fnSet.has(event.fn)) {
    return;
  }

  if (event.t === 1) {
    return;
  }

  const [a0, a1] = event.a ?? [];

  if (!isNumberValue(a0) || !isNumberValue(a1) || !isStringValue(event.v)) {
    return;
  }

  const key = `${event.fn}|${a0}|${a1}`;
  const ballot = votes.get(key) ?? new Map<string, number>();

  ballot.set(event.v, (ballot.get(event.v) ?? 0) + 1);
  votes.set(key, ballot);
};

/**
 * 多锚点 cret 事实采集：每个锚点重放一次封闭运行时，按 (函数, 实参) 投票。
 * 污点条目（t，调用子树消费过种子）跳过——"感染即不可常量化"。
 */
const collectCretVotes = async (
  ctx: TransformContext,
  corpus: Corpus,
  fnNames: string[]
): Promise<VoteTally> => {
  const fnSet = new Set(fnNames);
  const votes = new Map<string, Map<string, number>>();
  let runs = 0;

  for (const sample of corpus.samples) {
    // 锚点必须按序重放：磁带与种子消耗序是恒等判定的依据，并行会改变顺序
    // oxlint-disable-next-line eslint/no-await-in-loop -- 锚点必须串行按序重放：并行会改变磁带/种子消耗序，即改变恒等判定依据
    const out = await replayAnchor(ctx, corpus, sample, fnNames);

    if (out === null) {
      continue;
    }

    runs += 1;

    for (const event of out.trace?.events ?? []) {
      tallyCretEvent(event, fnSet, votes);
    }
  }

  return { votes, runs };
};

/** 跨锚点一致的事实才进回填表；候选值不唯一 → 冲突键弃用 */
const pickConsistentFacts = (
  votes: Map<string, Map<string, number>>
): FactTable => {
  const table = new Map<string, string>();
  let conflicts = 0;

  for (const [key, ballot] of votes) {
    if (ballot.size === 1) {
      const [only] = ballot.keys();

      table.set(key, only);
    } else {
      conflicts += 1;
    }
  }

  return { table, conflicts };
};

/** 调用点回填（字面量参数按键匹配）；返回成功替换数 */
const inlineStringSites = (
  ast: t.File,
  fnNames: string[],
  table: Map<string, string>
): number => {
  const fnSet = new Set(fnNames);
  const sites: StringSite[] = [];

  const visitCall = (path: NodePath<t.CallExpression>): void => {
    const { callee, arguments: args } = path.node;

    if (!t.isIdentifier(callee) || !fnSet.has(callee.name)) {
      return;
    }

    if (args.length !== 2) {
      return;
    }

    const a0 = numericLiteralOf(args[0]);
    const a1 = numericLiteralOf(args[1]);

    if (a0 === null || a1 === null) {
      return;
    }

    const v = table.get(`${callee.name}|${a0}|${a1}`);

    if (v === undefined) {
      return;
    }

    sites.push({ path, v });
  };

  traverse(ast, { CallExpression: visitCall });

  let replaced = 0;

  for (const { path, v } of sites) {
    try {
      path.replaceWith(t.stringLiteral(v));
      replaced += 1;
    } catch {
      /* skip */
    }
  }

  return replaced;
};

export const jsconfuserStrings: Transform = {
  name: "jsconfuser-strings",
  risk: "unsafe",
  async run(ast, ctx) {
    const strFns = detectStrFunctions(ast);

    if (strFns.length === 0) {
      return result(false, ["no STR functions"]);
    }

    if (!ctx.corpus || ctx.corpus.samples.length === 0) {
      return result(false, ["no corpus"]);
    }

    // ---------- 1) 多锚点 cret 事实采集 ----------
    const { votes, runs } = await collectCretVotes(ctx, ctx.corpus, strFns);

    if (runs === 0) {
      return result(false, ["trace runs failed"]);
    }

    // ---------- 2) 一致事实 → 回填表（跨锚点冲突的键弃用） ----------
    const { table, conflicts } = pickConsistentFacts(votes);

    // ---------- 3) 调用点回填（字面量参数按键匹配） ----------
    const replaced = inlineStringSites(ast, strFns, table);

    if (replaced === 0) {
      return result(false, [
        `fns=${strFns.length} facts=${table.size} no literal sites`,
      ]);
    }

    return result(true, [
      `fns=${strFns.length}`,
      `facts=${table.size}`,
      `inlined=${replaced}`,
      ...(conflicts > 0 ? [`conflicts=${conflicts}`] : []),
    ]);
  },
};
