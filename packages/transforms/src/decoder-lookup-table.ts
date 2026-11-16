/**
 * 解码器查找表替换（trace 驱动的恒等变换，"动态产生事实、静态执行改写"的 M2.4 实例）：
 *
 *  1. 在全部锚点样本上重放当前代码并开启 cret trace（call 实参+返回值）
 *  2. 聚合每个解码函数的 (args → 返回值) 表；同 args 出现不同返回值 → 判非确定，放弃
 *  3. 把解码函数体替换为：
 *
 *       function dec(a, b) \{
 *         switch ('' + a + '|' + b) \{      // 运行时查表（fast path）
 *           case '448|kEwV': return 'SECRET_KEY_123';
 *           ...
 *           default: return dec__orig(a, b);  // 未观测输入 → 原实现（保守恒等）
 *         \}
 *       \}
 *       function dec__orig(a, b) \{ ...原函数体... \}
 *
 *  语义：已观测输入走表，未观测输入走原逻辑——对纯函数（种子零消费前提）恒等，
 *  由锚库逐条验证把关。价值：全部解码明文变成代码中可见的常量（覆盖静态
 *  inline-decoder 处理不了的非字面量参数调用点）。
 */

import type { NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import type { AnchorSample, Corpus } from "@jsseal/anchors";
import { traverse } from "@jsseal/ast";
import { runSealed } from "@jsseal/runtime";
import type { TraceEvent } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform, TransformContext } from "./types";

const MAX_TABLE_ENTRIES = 50_000;

/** 小表阈值：switch 可读；超过则用对象映射（sojson 5000+ 条避免巨型 switch） */
const SWITCH_TABLE_LIMIT = 128;

/** 表值域：trace 返回值里可回填成字面量的原始值 */
type TableValue = string | number | boolean | null | undefined;

/** 表值判定：trace 事件来自引擎 JSON，形状只能运行时判定（非原始值不可常量化） */
const isTableValue = (v: unknown): v is TableValue => {
  if (v === null || v === undefined) {
    return true;
  }

  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
};

/** 与生成代码的键表达式（'' + a + '|' + b）保持一致的键生成 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters, typescript/restrict-template-expressions -- 实参是 trace 里的任意 JS 值，且键必须与生成代码 ''+a 的 ToString 同语义（Symbol 抛错），改用 String(x) 会改变行为
const keyOf = (args: unknown[]): string => args.map((x) => `${x}`).join("|");

/** 一次采样的聚合产物 */
interface SamplingOutcome {
  conflicted: Set<string>;
  conflictSkipped: number;
  tables: Map<string, Map<string, TableValue>>;
  taintedSkipped: number;
}

/** 函数体重建结果 */
interface TableApplication {
  notes: string[];
  replaced: number;
}

/** 重放锚点并取回 trace 事件；故障（异常/超限）返回 null */
const replayEvents = async (
  sample: AnchorSample,
  ctx: TransformContext,
  decoderNames: string[]
): Promise<TraceEvent[] | null> => {
  let out;

  try {
    out = await runSealed({
      code: ctx.code,
      mode: "replay",
      tapes: sample.tapes,
      backend: "native",
      trace: { callArgs: true, cretFns: decoderNames },
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

  return out.trace?.events ?? [];
};

/** 全锚点采样：聚合 (fn → argsKey → v) 表 */
const sampleDecoders = async (
  decoderNames: string[],
  corpus: Corpus,
  ctx: TransformContext
): Promise<SamplingOutcome> => {
  const tables = new Map<string, Map<string, TableValue>>();
  // 冲突键（"fn|key"）：该键此后走 fallback 原实现
  const conflictedKeys = new Set<string>();
  const conflicted = new Set<string>();
  const decoderSet = new Set(decoderNames);
  let taintedSkipped = 0;
  let conflictSkipped = 0;

  const observe = (fn: string, key: string, v: TableValue): void => {
    let tbl = tables.get(fn);

    if (!tbl) {
      tbl = new Map();
      tables.set(fn, tbl);
    }

    if (tbl.has(key)) {
      if (JSON.stringify(tbl.get(key)) !== JSON.stringify(v)) {
        tbl.delete(key);
        conflictedKeys.add(`${fn}|${key}`);
        conflictSkipped += 1;
      }
    } else if (!conflictedKeys.has(`${fn}|${key}`)) {
      if (tbl.size >= MAX_TABLE_ENTRIES) {
        conflicted.add(fn);

        return;
      }

      tbl.set(key, v);
    }
  };

  for (const sample of corpus.samples) {
    // 强制锚点走不同路径
    if (sample.forceIndex !== undefined) {
      continue;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- 锚点必须复用同一封闭运行时实例串行重放，并行会改变执行时序
    const events = await replayEvents(sample, ctx, decoderNames);

    for (const ev of events ?? []) {
      if (
        ev.k === "cret" &&
        ev.a &&
        decoderSet.has(ev.fn) &&
        !conflicted.has(ev.fn)
      ) {
        if (ev.t) {
          // 污点：输出感染种子（不稳定变量）→ 该条目不可常量化，跳过
          taintedSkipped += 1;
        } else if (isTableValue(ev.v)) {
          observe(ev.fn, keyOf(ev.a), ev.v);
        }
      }
    }
  }

  return { conflicted, conflictSkipped, tables, taintedSkipped };
};

/** 形参名列表；含非简单标识符形参（解构/默认值/rest）返回 null——不处理 */
const identifierNamesOf = (
  params: t.FunctionDeclaration["params"]
): string[] | null => {
  const names: string[] = [];

  for (const p of params) {
    if (!t.isIdentifier(p)) {
      return null;
    }

    names.push(p.name);
  }

  return names;
};

/** 键表达式：'' + a + '|' + b（与 keyOf 一致） */
const buildKeyExpr = (paramNames: string[]): t.Expression => {
  let keyExpr: t.Expression = t.binaryExpression(
    "+",
    t.stringLiteral(""),
    t.identifier(paramNames[0])
  );

  for (let i = 1; i < paramNames.length; i += 1) {
    keyExpr = t.binaryExpression(
      "+",
      keyExpr,
      t.binaryExpression("+", t.stringLiteral("|"), t.identifier(paramNames[i]))
    );
  }

  return keyExpr;
};

/** 小表：switch 查表 + default 走原实现 */
const switchDispatcher = (
  keyExpr: t.Expression,
  tbl: Map<string, TableValue>,
  origName: string,
  paramNames: string[]
): t.Statement => {
  const cases: t.SwitchCase[] = [];

  for (const [key, v] of tbl) {
    cases.push(
      t.switchCase(t.stringLiteral(key), [t.returnStatement(t.valueToNode(v))])
    );
  }

  cases.push(
    t.switchCase(null, [
      t.returnStatement(
        t.callExpression(
          t.identifier(origName),
          paramNames.map((n) => t.identifier(n))
        )
      ),
    ])
  );

  return t.switchStatement(keyExpr, cases);
};

/** 大表：对象映射查表（避免巨型 switch）+ 未命中走原实现 */
const objectDispatcher = (
  keyExpr: t.Expression,
  tbl: Map<string, TableValue>,
  origName: string,
  paramNames: string[],
  scope: Scope
): t.Statement => {
  const props: t.ObjectProperty[] = [];

  for (const [key, v] of tbl) {
    props.push(t.objectProperty(t.stringLiteral(key), t.valueToNode(v)));
  }

  const tblVar = scope.generateUidIdentifier("decTbl");

  return t.blockStatement([
    t.variableDeclaration("var", [
      t.variableDeclarator(tblVar, t.objectExpression(props)),
    ]),
    t.ifStatement(
      t.binaryExpression("in", keyExpr, t.identifier(tblVar.name)),
      t.returnStatement(
        t.memberExpression(t.identifier(tblVar.name), keyExpr, true)
      ),
      t.returnStatement(
        t.callExpression(
          t.identifier(origName),
          paramNames.map((n) => t.identifier(n))
        )
      )
    ),
  ]);
};

/** 用"查表分发 + __orig 回退"重建解码函数声明 */
const buildDecoderFunction = (
  path: NodePath<t.FunctionDeclaration>,
  name: string,
  paramNames: string[],
  tbl: Map<string, TableValue>
): t.FunctionDeclaration => {
  const keyExpr = buildKeyExpr(paramNames);
  const origName = `${name}__orig`;

  // fallback 原函数（重命名保留）
  const origFn = t.functionDeclaration(
    t.identifier(origName),
    path.node.params,
    path.node.body
  );

  // 注意：params 被复用——克隆避免 AST 节点共享
  origFn.params = path.node.params.map((p) => t.cloneNode(p));

  const dispatcher =
    tbl.size <= SWITCH_TABLE_LIMIT
      ? switchDispatcher(keyExpr, tbl, origName, paramNames)
      : objectDispatcher(keyExpr, tbl, origName, paramNames, path.scope);

  const newBody = t.blockStatement([
    dispatcher,
    t.functionDeclaration(t.identifier(origName), origFn.params, origFn.body),
  ]);

  return t.functionDeclaration(
    t.identifier(name),
    path.node.params.map((p) => t.cloneNode(p)),
    newBody
  );
};

/** 找到解码函数声明并替换函数体——返回表 note 与替换计数 */
const applyTables = (
  ast: t.File,
  tables: Map<string, Map<string, TableValue>>,
  conflicted: Set<string>
): TableApplication => {
  const notes: string[] = [];
  const handled = new Set<string>();
  let replaced = 0;

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- babel traverse 的 visitor 键必须是 AST 节点类型名
    FunctionDeclaration(path) {
      const name = path.node.id?.name;

      if (name === undefined || name === "" || handled.has(name)) {
        return;
      }

      const tbl = tables.get(name);

      if (!tbl || tbl.size === 0 || conflicted.has(name)) {
        return;
      }

      const paramNames = identifierNamesOf(path.node.params);

      // 解码函数最多 3 个形参：更多形参的键表达式会与 trace 实参数错位
      if (paramNames === null || paramNames.length === 0) {
        return;
      }

      if (paramNames.length > 3) {
        return;
      }

      path.replaceWith(buildDecoderFunction(path, name, paramNames, tbl));
      handled.add(name);
      replaced += 1;
      notes.push(`${name}:${tbl.size}`);
    },
  });

  return { notes, replaced };
};

export const decoderLookupTable: Transform = {
  name: "decoder-lookup-table",
  // 执行求值采样 + 函数体替换（锚库验证把关）
  risk: "unsafe",
  async run(ast, ctx) {
    const plan = ctx.detection.obfuscatorIO;

    if (!plan || plan.decoderNames.length === 0) {
      return result(false, ["no decoder plan"]);
    }

    if (ctx.backend !== "native") {
      return result(false, ["native backend only"]);
    }

    if (!ctx.corpus || ctx.corpus.samples.length === 0) {
      return result(false, ["no corpus"]);
    }

    const outcome = await sampleDecoders(plan.decoderNames, ctx.corpus, ctx);
    const application = applyTables(ast, outcome.tables, outcome.conflicted);
    const notes = [...application.notes];

    if (outcome.taintedSkipped > 0) {
      notes.push(`tainted-skipped=${outcome.taintedSkipped}`);
    }

    if (outcome.conflictSkipped > 0) {
      notes.push(`conflict-keys-skipped=${outcome.conflictSkipped}`);
    }

    if (application.replaced === 0) {
      return result(false, [
        outcome.conflicted.size > 0
          ? `conflicted=${[...outcome.conflicted].join(",")}`
          : "no table",
        ...notes,
      ]);
    }

    return result(true, [`tables=${application.replaced}`, ...notes]);
  },
};
