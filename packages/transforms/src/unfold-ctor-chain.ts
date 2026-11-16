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

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import type { Corpus } from "@jsseal/anchors";
import { parseCode, traverse } from "@jsseal/ast";
import { runSealed } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform, TransformContext } from "./types";

/** X.constructor / X["constructor"] */
const isConstructorMember = (node: t.MemberExpression): boolean => {
  const prop = node.property;

  if (!node.computed && t.isIdentifier(prop) && prop.name === "constructor") {
    return true;
  }

  if (
    node.computed &&
    t.isStringLiteral(prop) &&
    prop.value === "constructor"
  ) {
    return true;
  }

  return false;
};

/** 形态 A：CallExpression\{ callee: Call\{ callee: X.constructor, args: [StringLiteral] \}, args: [] \} */
const matchStaticCtorCall = (expr: t.Expression): string | null => {
  if (!t.isCallExpression(expr) || expr.arguments.length !== 0) {
    return null;
  }

  const inner = expr.callee;

  if (!t.isCallExpression(inner) || inner.arguments.length !== 1) {
    return null;
  }

  if (
    !t.isMemberExpression(inner.callee) ||
    !isConstructorMember(inner.callee)
  ) {
    return null;
  }

  const [body] = inner.arguments;

  if (!t.isStringLiteral(body)) {
    return null;
  }

  return body.value;
};

/** 值是否是 AST 节点（动态取值后唯一的形状证据：带 type 字段的对象） */
const isAstNodeLike = (v: unknown): v is t.Node =>
  typeof v === "object" && v !== null && "type" in v;

/** 形态 B 判定：子树内不含任何字面内容节点（JSFuck 全编码的结构特征） */
const isOpaqueCharsetStatement = (node: t.Node): boolean => {
  let opaque = true;

  // 动态 AST 遍历：子节点的字段名只有运行时可枚举（babel Node 无索引签名），
  // 所以按 Object.entries 取值，再用 isAstNodeLike 建立"是节点"的类型证据
  const walk = (n: t.Node): void => {
    if (!opaque) {
      return;
    }

    if (t.isIdentifier(n) || t.isStringLiteral(n) || t.isNumericLiteral(n)) {
      opaque = false;

      return;
    }

    for (const [key, v] of Object.entries(n)) {
      if (
        key === "loc" ||
        key === "leadingComments" ||
        key === "trailingComments"
      ) {
        continue;
      }

      if (Array.isArray(v)) {
        for (const c of v) {
          if (isAstNodeLike(c)) {
            walk(c);
          }
        }
      } else if (isAstNodeLike(v)) {
        walk(v);
      }
    }
  };

  walk(node);

  return opaque;
};

/** 构造可解析的语句列表（不可解析返回 null） */
const parseStatements = (src: string): t.Statement[] | null => {
  try {
    const parsed = parseCode(src);
    const stmts = parsed.program.body;

    return stmts.length > 0 ? stmts.map((st) => t.cloneNode(st, true)) : null;
  } catch {
    return null;
  }
};

interface StaticJob {
  path: NodePath<t.ExpressionStatement>;
  stmts: t.Statement[];
}

/** 一次遍历收集到的两类站点 */
interface CtorSites {
  charsetSites: NodePath<t.ExpressionStatement>[];
  staticJobs: StaticJob[];
}

/** 收集两类站点：形态 A 静态 ctor 调用、形态 B 全编码调用语句 */
const collectSites = (ast: t.File): CtorSites => {
  const staticJobs: StaticJob[] = [];
  const charsetSites: NodePath<t.ExpressionStatement>[] = [];

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- babel traverse 的 visitor 键必须是 AST 节点类型名
    ExpressionStatement(path) {
      const expr = path.node.expression;
      const staticBody = matchStaticCtorCall(expr);

      if (staticBody !== null) {
        const stmts = parseStatements(staticBody);

        if (stmts) {
          staticJobs.push({ path, stmts });
        }

        return;
      }

      // 形态 B：不含字面内容的调用语句（JSFuck 全编码）
      if (t.isCallExpression(expr) && isOpaqueCharsetStatement(expr)) {
        charsetSites.push(path);
      }
    },
  });

  return { charsetSites, staticJobs };
};

/** 形态 A：静态回填——返回替换计数 */
const applyStaticJobs = (jobs: StaticJob[]): number => {
  let replaced = 0;

  for (const job of jobs) {
    try {
      job.path.replaceWithMultiple(job.stmts);
      replaced += 1;
    } catch {
      /* skip */
    }
  }

  return replaced;
};

/** 锚点重放：普通锚点的 Function 构造器条目；任一锚点故障返回 null（原"清空并停止"语义） */
const sampleFunctionEntries = async (
  corpus: Corpus,
  ctx: TransformContext
): Promise<string[][] | null> => {
  const logs: string[][] = [];

  for (const sample of corpus.samples) {
    // 强制锚点走不同路径
    if (sample.forceIndex !== undefined) {
      continue;
    }

    let out;

    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- 锚点必须复用同一封闭运行时实例串行重放，并行会改变执行时序
      out = await runSealed({
        code: ctx.code,
        mode: "replay",
        tapes: sample.tapes,
        entry: corpus.entry,
        backend: corpus.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch {
      return null;
    }

    if (
      out.flags.tapeExhausted === true ||
      out.flags.timeout === true ||
      out.flags.oom === true
    ) {
      return null;
    }

    logs.push((out.evalLog ?? []).filter((e) => e.startsWith("[Function] ")));
  }

  return logs;
};

/** 按序回填生成代码；解析或替换失败即停（原 break 语义）——返回已替换数 */
const applyCharsetBodies = (
  sites: NodePath<t.ExpressionStatement>[],
  bodies: string[]
): number => {
  for (const [i, site] of sites.entries()) {
    const stmts = parseStatements(bodies[i]);

    if (stmts === null) {
      return i;
    }

    try {
      site.replaceWithMultiple(stmts);
    } catch {
      return i;
    }
  }

  return sites.length;
};

/** 形态 B：evalLog 事实按序回填——返回替换计数与对应 note */
const replaceCharsetSites = async (
  charsetSites: NodePath<t.ExpressionStatement>[],
  corpus: Corpus,
  ctx: TransformContext
): Promise<{ note: string | null; replaced: number }> => {
  const logs = await sampleFunctionEntries(corpus, ctx);

  if (logs === null || logs.length === 0) {
    return { note: null, replaced: 0 };
  }

  const [firstLog] = logs;
  const first = JSON.stringify(firstLog);

  if (!logs.every((l) => JSON.stringify(l) === first)) {
    return { note: "fn-evalLog varies", replaced: 0 };
  }

  const bodies = firstLog.map((e) => e.slice("[Function] ".length));

  if (bodies.length < charsetSites.length) {
    return {
      note: `fn-entries ${bodies.length} < charset-sites ${charsetSites.length}`,
      replaced: 0,
    };
  }

  const replaced = applyCharsetBodies(charsetSites, bodies);

  return { note: replaced > 0 ? `charset=${replaced}` : null, replaced };
};

export const unfoldCtorChain: Transform = {
  name: "unfold-ctor-chain",
  risk: "unsafe",
  async run(ast, ctx) {
    const notes: string[] = [];
    const { charsetSites, staticJobs } = collectSites(ast);

    // ---------- 形态 A：静态回填 ----------
    const staticReplaced = applyStaticJobs(staticJobs);

    if (staticReplaced > 0) {
      notes.push(`static=${staticReplaced}`);
    }

    // ---------- 形态 B：evalLog 事实按序回填 ----------
    let charsetReplaced = 0;

    if (
      charsetSites.length > 0 &&
      ctx.corpus &&
      ctx.corpus.samples.length > 0
    ) {
      const outcome = await replaceCharsetSites(charsetSites, ctx.corpus, ctx);

      if (outcome.note !== null) {
        notes.push(outcome.note);
      }

      charsetReplaced = outcome.replaced;
    }

    const replaced = staticReplaced + charsetReplaced;

    return replaced > 0
      ? result(true, notes)
      : result(false, [...notes, "no ctor-chain sites"]);
  },
};
