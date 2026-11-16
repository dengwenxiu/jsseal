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

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";
import type { ObfuscatorIOPlan } from "@jsseal/detector";
import { runSealed } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform, TransformContext } from "./types";

/** 单次活跃调用上限：超过就不做封闭运行时求值（成本换收益不划算） */
const MAX_INLINE_CALLS = 20;

interface ActiveCallSite {
  name: string;
  path: NodePath<t.CallExpression>;
}

interface PoolAndDecoderNames {
  poolNames: Set<string>;
  decoderNames: Set<string>;
}

interface DecoderRequest {
  name: string;
  args: (string | number | undefined)[];
}

interface ProbeEntry {
  ok: boolean;
  v?: string;
}

/** 收集字符串池/解码器函数名，并沿 `var a = b` 别名链扩散 */
const collectPoolAndDecoderNames = (
  ast: t.File,
  plan: ObfuscatorIOPlan
): PoolAndDecoderNames => {
  const poolNames = new Set(plan.stringArrayNames);
  const decoderNames = new Set(plan.decoderNames);

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（VariableDeclarator），改成小驼峰会让该 visitor 永不触发
    VariableDeclarator: (path) => {
      const { id, init } = path.node;

      if (!t.isIdentifier(id) || !t.isIdentifier(init)) {
        return;
      }

      if (decoderNames.has(init.name)) {
        decoderNames.add(id.name);
      }

      if (poolNames.has(init.name)) {
        poolNames.add(id.name);
      }
    },
  });

  return { poolNames, decoderNames };
};

/** 当前节点是否处于某个解码器函数体内（递归 fallback 的内部调用不算活跃） */
const insideDecoderBody = (
  path: NodePath<t.CallExpression>,
  decoderNames: ReadonlySet<string>
): boolean => {
  let current: NodePath | null = path.parentPath;

  while (current) {
    const { node } = current;

    if (
      t.isFunctionDeclaration(node) &&
      node.id &&
      decoderNames.has(node.id.name)
    ) {
      return true;
    }

    current = current.parentPath;
  }

  return false;
};

/** 收集解码器的活跃调用点（排除解码器体内的自引用） */
const collectActiveCallSites = (
  ast: t.File,
  decoderNames: ReadonlySet<string>
): ActiveCallSite[] => {
  const sites: ActiveCallSite[] = [];

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（CallExpression），改成小驼峰会让该 visitor 永不触发
    CallExpression: (path) => {
      const { callee } = path.node;

      if (!t.isIdentifier(callee) || !decoderNames.has(callee.name)) {
        return;
      }

      if (insideDecoderBody(path, decoderNames)) {
        return;
      }

      sites.push({ name: callee.name, path });
    },
  });

  return sites;
};

/** 顶层声明是否是池函数/解码器函数（含别名） */
const isPoolOrDecoderFunction = (
  node: t.FunctionDeclaration,
  names: ReadonlySet<string>
): boolean => {
  if (node.id === null || node.id === undefined) {
    return false;
  }

  return names.has(node.id.name);
};

/** `poolFn && (...)` / `decoderFn && (...)` 副作用语句 */
const isPoolSideEffectStatement = (
  node: t.ExpressionStatement,
  names: ReadonlySet<string>
): boolean => {
  const { expression } = node;

  if (
    !t.isLogicalExpression(expression) ||
    expression.operator !== "&&" ||
    !t.isIdentifier(expression.left)
  ) {
    return false;
  }

  return names.has(expression.left.name);
};

/** `var alias = decoderName` 别名声明（全部 declarator 都是别名才算） */
const isAliasDeclaration = (
  node: t.VariableDeclaration,
  names: ReadonlySet<string>
): boolean => {
  if (node.declarations.length === 0) {
    return false;
  }

  return node.declarations.every((declarator) => {
    const { id, init } = declarator;

    if (!t.isIdentifier(id) || !init || !t.isIdentifier(init)) {
      return false;
    }

    return names.has(init.name);
  });
};

/** 移除池/解码器三件套及其别名、副作用语句；返回移除的语句数 */
const removePoolAndDecoderNodes = (
  ast: t.File,
  poolNames: ReadonlySet<string>,
  decoderNames: ReadonlySet<string>
): number => {
  const names = new Set([...poolNames, ...decoderNames]);
  let removed = 0;

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（FunctionDeclaration），改成小驼峰会让该 visitor 永不触发
    FunctionDeclaration: (path) => {
      if (isPoolOrDecoderFunction(path.node, names)) {
        path.remove();
        removed += 1;
      }
    },
    // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（ExpressionStatement），改成小驼峰会让该 visitor 永不触发
    ExpressionStatement: (path) => {
      if (isPoolSideEffectStatement(path.node, names)) {
        path.remove();
        removed += 1;
      }
    },
    // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（VariableDeclaration），改成小驼峰会让该 visitor 永不触发
    VariableDeclaration: (path) => {
      if (isAliasDeclaration(path.node, names)) {
        path.remove();
        removed += 1;
      }
    },
  });

  return removed;
};

/** 实参字面量取值；非字面量返回 undefined（调用点因此不可静态求值） */
const literalArgValue = (node: t.Node): string | number | undefined => {
  if (t.isStringLiteral(node) || t.isNumericLiteral(node)) {
    return node.value;
  }

  return undefined;
};

/** 把活跃调用点转成求值请求（名字在收集时已收窄，无需断言 callee） */
const readRequests = (sites: readonly ActiveCallSite[]): DecoderRequest[] =>
  sites.map((site) => ({
    name: site.name,
    args: site.path.node.arguments.map((arg) => literalArgValue(arg)),
  }));

/** `{ok, v?}` 探测结果的最小形状判别（值来自封闭运行时的 JSON 文本，必须自查） */
const isProbeEntry = (value: unknown): value is ProbeEntry => {
  if (typeof value !== "object" || value === null || !("ok" in value)) {
    return false;
  }

  if (typeof value.ok !== "boolean") {
    return false;
  }

  // v 缺省表示该次求值失败；存在则必须是字符串
  return !("v" in value) || typeof value.v === "string";
};

/** `__jsseal_ret_raw` 解析：形状不符的条目一律丢弃（等价于逐项 ok 判定） */
const parseProbeResults = (raw: string | undefined): ProbeEntry[] => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw ?? "[]");
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const entries: ProbeEntry[] = [];

  for (const item of parsed) {
    if (isProbeEntry(item)) {
      entries.push(item);
    }
  }

  return entries;
};

/** 在封闭运行时求值活跃调用并回填字面量；返回成功内联的调用点数 */
const inlineCallsViaSealedRun = async (
  sites: readonly ActiveCallSite[],
  reqs: readonly DecoderRequest[],
  prologueSource: string,
  ctx: TransformContext
): Promise<number> => {
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

  let out;

  try {
    out = await runSealed({
      code: `${prologueSource}\n${driver}`,
      mode: "record",
      backend: ctx.backend,
      timeoutMs: ctx.timeoutMs,
      memoryLimitBytes: ctx.memoryLimitBytes,
    });
  } catch {
    // eval 失败，保守跳过
    return 0;
  }

  if (
    out.flags.tapeExhausted === true ||
    out.flags.timeout === true ||
    out.flags.oom === true
  ) {
    return 0;
  }

  const values = parseProbeResults(out.ret);
  let inlined = 0;

  for (const [index, entry] of values.entries()) {
    // 原实现只回填两数组相交的前缀区间（多出的探测结果/缺失的结果均忽略）
    if (index >= sites.length || !entry.ok || entry.v === undefined) {
      continue;
    }

    sites[index].path.replaceWith(t.stringLiteral(entry.v));
    inlined += 1;
  }

  return inlined;
};

export const pruneDeadPool: Transform = {
  name: "prune-dead-pool",
  // 删除函数/语句（锚库验证把关）
  risk: "unsafe",
  async run(ast, ctx) {
    const plan = ctx.detection.obfuscatorIO;

    if (!plan || plan.stringArrayNames.length === 0) {
      return result(false, ["no plan"]);
    }

    const { poolNames, decoderNames } = collectPoolAndDecoderNames(ast, plan);

    // ---------- 1) 检测活跃的解码器调用 ----------
    const callSites = collectActiveCallSites(ast, decoderNames);

    // ---------- 2A) 无活跃调用 → 全部移除 ----------
    if (callSites.length === 0) {
      const removed = removePoolAndDecoderNodes(ast, poolNames, decoderNames);

      return removed > 0
        ? result(true, [`removed=${removed}`, "all-decoder-calls-inlined"])
        : result(false, ["nothing to prune"]);
    }

    // ---------- 2B) 有活跃调用 → 尝试内联后移除 ----------
    if (callSites.length <= MAX_INLINE_CALLS && plan.prologueSource) {
      const reqs = readRequests(callSites);

      // 全部参数必须是字面量
      if (reqs.every((req) => req.args.every((arg) => arg !== undefined))) {
        const inlined = await inlineCallsViaSealedRun(
          callSites,
          reqs,
          plan.prologueSource,
          ctx
        );

        if (inlined === callSites.length) {
          // 全部内联成功 → 递归调用自身移除（下一轮 governor 会再跑）
          return result(true, [
            `inlined-remaining=${inlined}`,
            "next-round-will-prune",
          ]);
        }
      }
    }

    return result(false, [
      `active-calls=${callSites.length}`,
      "cannot-prune-yet",
    ]);
  },
};
