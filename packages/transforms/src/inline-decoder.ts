/**
 * 解码函数内联（obfuscator.io string array 的特化，"纯函数 + 常量入参 → 执行内联"的第一实例）：
 *
 * 新版 obfuscator.io 的调用点走别名链：函数内 `var a = b` 链式指向解码函数
 * （_0x5e2f08 → _0x261df8 → _0x423b）。
 *
 * 流程：
 *  1. 收集别名链并解析到规范解码函数名
 *  2. 收集调用点（实参全字面量；跳过 prologue 内部——轮转 IIFE 的调用必须保留）
 *  3. 封闭运行时执行三件套 prologue，批量求值；校验种子零消费（纯度前提）
 *  4. 字面量回填 → 清理无引用别名 → prologue 外无引用时移除三件套
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";
import { isPoolRotatorStatement } from "@jsseal/detector";
import { runSealed } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform } from "./types";

/** 包装实参静态求值域：调用点只接受字符串/数字字面量，一元/二元运算保持原值域 */
type StaticValue = string | number | boolean;

interface CallReq {
  path: NodePath<t.CallExpression>;
  name: string;
  args: StaticValue[];
}

/** 包装层（stringArrayWrappers）的静态形态：函数体只有一条 return，返回 decoder 调用 */
interface WrapperPlan {
  decoder: string;
  params: string[];
  argExprs: t.Expression[];
}

const isLiteralArg = (a: t.Node): a is t.StringLiteral | t.NumericLiteral =>
  t.isStringLiteral(a) || t.isNumericLiteral(a);

/** 调用点实参 → 原始值；空参或含非字面量 → null（该调用点不内联） */
const literalArgValues = (
  args: t.CallExpression["arguments"]
): StaticValue[] | null => {
  if (args.length === 0) {
    return null;
  }

  const values: StaticValue[] = [];

  for (const arg of args) {
    if (!isLiteralArg(arg)) {
      return null;
    }

    values.push(arg.value);
  }

  return values;
};

/** 表达式是否为「标识符(限 params)/字面量/一元/二元」的简单算术（包装实参合法性） */
const isSimpleArith = (node: t.Node, allowed: Set<string>): boolean => {
  if (t.isIdentifier(node)) {
    return allowed.has(node.name);
  }

  if (
    t.isNumericLiteral(node) ||
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node)
  ) {
    return true;
  }

  if (t.isUnaryExpression(node)) {
    return (
      ["-", "+", "!"].includes(node.operator) &&
      isSimpleArith(node.argument, allowed)
    );
  }

  if (t.isBinaryExpression(node)) {
    return (
      ["+", "-", "*", "/", "%"].includes(node.operator) &&
      isSimpleArith(node.left, allowed) &&
      isSimpleArith(node.right, allowed)
    );
  }

  return false;
};

/**
 * '+' 的原生语义：任一侧是字符串则拼接，否则两侧 ToNumber 相加。
 * TS 无法对 string|number|boolean 联合直接应用 '+'，收窄只发生在编译期。
 */
const addStatic = (left: StaticValue, right: StaticValue): StaticValue =>
  // SAFETY: 表达式仍是原生 '+'，结果类型由实参的运行时类型决定；断言不改变求值方式
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 改写成 Number(left)+Number(right) 会把字符串拼接变成数值相加，算出的常量就错了
  (left as number) + (right as number);

/** 二元运算操作数（'#x in obj' 的 PrivateName 不参与静态求值） */
const staticOperand = (
  node: t.Expression | t.PrivateName
): t.Expression | undefined => (t.isPrivateName(node) ? undefined : node);

/** 静态求值：包装实参表达式在 env（参数→字面量值）下求值；不可静态确定 → undefined */
const evalStaticArg = (
  node: t.Expression,
  env: Map<string, StaticValue>
): StaticValue | undefined => {
  if (
    t.isNumericLiteral(node) ||
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node)
  ) {
    return node.value;
  }

  if (t.isIdentifier(node)) {
    return env.get(node.name);
  }

  if (t.isUnaryExpression(node)) {
    const value = evalStaticArg(node.argument, env);

    if (value === undefined) {
      return undefined;
    }

    if (node.operator === "-") {
      return -Number(value);
    }

    if (node.operator === "+") {
      return Number(value);
    }

    return undefined;
  }

  if (!t.isBinaryExpression(node)) {
    return undefined;
  }

  const leftOperand = staticOperand(node.left);
  const rightOperand = staticOperand(node.right);

  if (leftOperand === undefined || rightOperand === undefined) {
    return undefined;
  }

  const left = evalStaticArg(leftOperand, env);
  const right = evalStaticArg(rightOperand, env);

  if (left === undefined || right === undefined) {
    return undefined;
  }

  if (node.operator === "+") {
    return addStatic(left, right);
  }

  if (node.operator === "-") {
    return Number(left) - Number(right);
  }

  if (node.operator === "*") {
    return Number(left) * Number(right);
  }

  if (node.operator === "/") {
    return Number(left) / Number(right);
  }

  if (node.operator === "%") {
    return Number(left) % Number(right);
  }

  return undefined;
};

/** JSON 数组边界解析（驱动回读通道）：语法错误或非数组 → null */
const parseJsonArray = (raw: string | undefined): unknown[] | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  // SAFETY: Array.isArray 已确认是数组；元素类型刻意退化为 unknown，由 isEvalSuccess/isStaticValue 逐个判形
  return parsed as unknown[];
};

/** 回填值域判定：只有原始值能成为字面量（对象/数组/undefined 一律拒绝） */
const isStaticValue = (value: unknown): value is StaticValue =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean";

/** 驱动回读的成功条目：ok 为 true 且带值字段 v */
interface EvalSuccess {
  ok: true;
  v: unknown;
}

/** 成功条目判定（驱动侧写入 ok/v，回读时逐个判形） */
const isEvalSuccess = (entry: unknown): entry is EvalSuccess => {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  return "ok" in entry && entry.ok === true && "v" in entry;
};

/** 驱动回读结果 → 原始值数组；非成功条目/值非原始类型的位置留 undefined（计为失败） */
const readEvalValues = (entries: unknown[]): (StaticValue | undefined)[] =>
  entries.map((entry) =>
    isEvalSuccess(entry) && isStaticValue(entry.v) ? entry.v : undefined
  );

/** 路径是否位于 prologue（三件套函数体 / 轮转 IIFE）内部 */
const isInsidePrologue = (
  path: NodePath,
  prologueNames: Set<string>
): boolean => {
  let current = path.parentPath;

  while (current !== null) {
    const { node } = current;

    if (t.isFunctionDeclaration(node)) {
      const name = node.id?.name;

      if (name !== undefined && prologueNames.has(name)) {
        return true;
      }
    }

    if (
      t.isExpressionStatement(node) &&
      isPoolRotatorStatement(node, prologueNames)
    ) {
      return true;
    }

    current = current.parentPath;
  }

  return false;
};

/** var A = B 的直连别名表（别名链的静态骨架） */
const collectVarAliases = (ast: t.File): Map<string, string> => {
  const varAliases = new Map<string, string>();

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
    VariableDeclarator: (path) => {
      const { id } = path.node;
      const { init } = path.node;

      if (t.isIdentifier(id) && t.isIdentifier(init)) {
        varAliases.set(id.name, init.name);
      }
    },
  });

  return varAliases;
};

/**
 * 包装层收集（stringArrayWrappers）：参数置换/偏移的纯函数包装，
 * 调用点 w(l1, l2) 静态代入即可求出 decoder 实参。
 */
const collectWrapperPlans = (
  ast: t.File,
  decoderSet: Set<string>,
  resolveToDecoder: (name: string) => string | null
): Map<string, WrapperPlan> => {
  const wrappers = new Map<string, WrapperPlan>();

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
    FunctionDeclaration: (path) => {
      const name = path.node.id?.name;

      if (name === undefined || decoderSet.has(name)) {
        return;
      }

      const { body: fnBody } = path.node.body;

      if (fnBody.length !== 1) {
        return;
      }

      const [statement] = fnBody;

      if (
        !t.isReturnStatement(statement) ||
        !statement.argument ||
        !t.isCallExpression(statement.argument)
      ) {
        return;
      }

      const call = statement.argument;
      const { callee } = call;

      if (!t.isIdentifier(callee)) {
        return;
      }

      const target =
        resolveToDecoder(callee.name) ??
        (wrappers.has(callee.name) ? callee.name : null);

      if (target === null) {
        return;
      }

      const paramNames: string[] = [];
      let paramsAreIdentifiers = true;

      for (const param of path.node.params) {
        if (t.isIdentifier(param)) {
          paramNames.push(param.name);
        } else {
          paramsAreIdentifiers = false;
        }
      }

      if (!paramsAreIdentifiers) {
        return;
      }

      const allowed = new Set(paramNames);
      const argExprs = call.arguments.filter(t.isExpression);

      if (
        argExprs.length === 0 ||
        argExprs.length !== call.arguments.length ||
        !argExprs.every((expr) => isSimpleArith(expr, allowed))
      ) {
        return;
      }

      wrappers.set(name, { decoder: target, params: paramNames, argExprs });
    },
  });

  return wrappers;
};

/** name → 被引用次数（只统计给定名字集合；别名/包装的不动点清理共用） */
const countReferences = (
  ast: t.File,
  names: Set<string>
): Map<string, number> => {
  const refCounts = new Map<string, number>();

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
    ReferencedIdentifier: (path) => {
      if (names.has(path.node.name)) {
        refCounts.set(path.node.name, (refCounts.get(path.node.name) ?? 0) + 1);
      }
    },
  });

  return refCounts;
};

/** 清理无引用的别名声明（不动点迭代：别名链层层失效） */
const removeDeadAliases = (ast: t.File, aliasNames: Set<string>): void => {
  for (let iter = 0; iter < 6 && aliasNames.size > 0; iter += 1) {
    const refCounts = countReferences(ast, aliasNames);
    const dead: { path: NodePath<t.VariableDeclarator>; name: string }[] = [];

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
      VariableDeclarator: (path) => {
        const { id } = path.node;

        if (!t.isIdentifier(id) || !t.isIdentifier(path.node.init)) {
          return;
        }

        if (aliasNames.has(id.name) && (refCounts.get(id.name) ?? 0) === 0) {
          dead.push({ path, name: id.name });
        }
      },
    });

    if (dead.length === 0) {
      return;
    }

    for (const { path, name } of dead) {
      path.remove();
      aliasNames.delete(name);
    }
  }
};

/** 清理无引用的包装函数（不动点） */
const removeDeadWrappers = (ast: t.File, wrapperNames: Set<string>): void => {
  for (let iter = 0; iter < 6 && wrapperNames.size > 0; iter += 1) {
    const refCounts = countReferences(ast, wrapperNames);
    const dead: NodePath<t.FunctionDeclaration>[] = [];

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
      FunctionDeclaration: (path) => {
        const name = path.node.id?.name;

        if (name === undefined || !wrapperNames.has(name)) {
          return;
        }

        if ((refCounts.get(name) ?? 0) === 0) {
          dead.push(path);
        }
      },
    });

    if (dead.length === 0) {
      return;
    }

    for (const path of dead) {
      const name = path.node.id?.name;

      path.remove();

      if (name !== undefined) {
        wrapperNames.delete(name);
      }
    }
  }
};

/** prologue 之外对三件套名的引用计数（非零即不可删） */
const countOutsidePrologueRefs = (
  ast: t.File,
  prologueNames: Set<string>
): number => {
  let outsideRefs = 0;

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
    ReferencedIdentifier: (path) => {
      if (
        prologueNames.has(path.node.name) &&
        !isInsidePrologue(path, prologueNames)
      ) {
        outsideRefs += 1;
      }
    },
  });

  return outsideRefs;
};

/** 回填计数：replaced = 成功内联数，failed = 求值失败数 */
interface ReplaceCounts {
  replaced: number;
  failed: number;
}

/** 字面量回填：只回填原始值，其余计为失败 */
const replaceCallSites = (
  reqs: CallReq[],
  values: (StaticValue | undefined)[]
): ReplaceCounts => {
  let replaced = 0;
  let failed = 0;

  for (const [index, req] of reqs.entries()) {
    const value = values[index];

    if (value === undefined) {
      failed += 1;

      continue;
    }

    req.path.replaceWith(t.valueToNode(value));
    replaced += 1;
  }

  return { replaced, failed };
};

/** IIFE 调用（轮转器本体）：序列表达式里被摘掉的那一段 */
const isIifeCall = (node: t.Node): boolean =>
  t.isCallExpression(node) &&
  (t.isFunctionExpression(node.callee) ||
    t.isArrowFunctionExpression(node.callee));

/** 三件套整体移除：函数声明删除；轮转 IIFE 只摘掉 IIFE 调用，同语句的其它表达式保留 */
const stripPrologueStatements = (
  ast: t.File,
  prologueNames: Set<string>
): void => {
  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
    FunctionDeclaration: (path) => {
      const name = path.node.id?.name;

      if (name !== undefined && prologueNames.has(name)) {
        path.remove();
      }
    },
    // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
    ExpressionStatement: (path) => {
      const { node } = path;

      if (!isPoolRotatorStatement(node, prologueNames)) {
        return;
      }

      const expr = node.expression;

      if (t.isSequenceExpression(expr) && expr.expressions.length > 1) {
        const kept = expr.expressions.filter((e) => !isIifeCall(e));

        if (kept.length === 1) {
          path.replaceWith(t.expressionStatement(kept[0]));
        } else {
          node.expression = t.sequenceExpression(kept);
        }

        return;
      }

      path.remove();
    },
  });
};

export const inlineDecoder: Transform = {
  name: "inline-decoder",
  // 执行求值（封闭运行时内，种子零消费校验 + 锚库把关）
  risk: "unsafe",
  async run(ast, ctx) {
    const plan = ctx.detection.obfuscatorIO;

    if (!plan || plan.decoderNames.length === 0 || !plan.prologueSource) {
      return result(false, ["no decoder plan"]);
    }

    const decoderSet = new Set(plan.decoderNames);

    const prologueNames = new Set<string>([
      ...plan.decoderNames,
      ...plan.stringArrayNames,
    ]);

    // ---------- 1) 别名链：var A = B 的直连表 + 解析 ----------
    const varAliases = collectVarAliases(ast);

    const resolveToDecoder = (name: string): string | null => {
      let current = name;

      for (let depth = 0; depth < 8; depth += 1) {
        if (decoderSet.has(current)) {
          return current;
        }

        const next = varAliases.get(current);

        if (next === undefined) {
          return null;
        }

        current = next;
      }

      return null;
    };

    // ---------- 1b) 包装层（stringArrayWrappers）：w(a,b){return dec(a+off, b)} ----------
    const wrappers = collectWrapperPlans(ast, decoderSet, resolveToDecoder);

    /** 调用点解析：w(l1,l2) → decoder 与代入后的实参（支持别名链 + 包装链） */
    const resolveCall = (
      calleeName: string,
      argValues: StaticValue[]
    ): { decoder: string; args: StaticValue[] } | null => {
      const direct = resolveToDecoder(calleeName);

      if (direct !== null) {
        return { decoder: direct, args: argValues };
      }

      let name = calleeName;
      let args = argValues;

      for (let depth = 0; depth < 4; depth += 1) {
        const wrapper = wrappers.get(name);

        if (wrapper === undefined) {
          return null;
        }

        if (args.length !== wrapper.params.length) {
          return null;
        }

        const env = new Map<string, StaticValue>();

        for (const [index, param] of wrapper.params.entries()) {
          env.set(param, args[index]);
        }

        const next: StaticValue[] = [];

        for (const expr of wrapper.argExprs) {
          const value = evalStaticArg(expr, env);

          if (value === undefined) {
            return null;
          }

          next.push(value);
        }

        const decoder = resolveToDecoder(wrapper.decoder);

        if (decoder !== null) {
          return { decoder, args: next };
        }

        name = wrapper.decoder;
        args = next;
      }

      return null;
    };

    // ---------- 2) 调用点收集 ----------
    const reqs: CallReq[] = [];

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
      CallExpression: (path) => {
        const { callee } = path.node;

        // 轮转 IIFE 内部调用不动
        if (!t.isIdentifier(callee) || isInsidePrologue(path, prologueNames)) {
          return;
        }

        const argValues = literalArgValues(path.node.arguments);

        if (argValues === null) {
          return;
        }

        const resolved = resolveCall(callee.name, argValues);

        if (resolved === null) {
          return;
        }

        reqs.push({ path, name: resolved.decoder, args: resolved.args });
      },
    });

    if (reqs.length === 0) {
      return result(false, ["no literal call sites"]);
    }

    // ---------- 3) 封闭运行时批量求值 ----------
    const driverCode = `
var __reqs = ${JSON.stringify(reqs.map((r) => ({ name: r.name, args: r.args })))};
var __out = [];
for (var __i = 0; __i < __reqs.length; __i++) {
  try {
    __out[__i] = { ok: true, v: globalThis[__reqs[__i].name].apply(null, __reqs[__i].args) };
  } catch (e) {
    __out[__i] = { ok: false, e: String(e) };
  }
}
globalThis.__jsseal_ret_raw = JSON.stringify(__out);
`;

    let out;

    try {
      out = await runSealed({
        code: `${plan.prologueSource}\n${driverCode}`,
        mode: "record",
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return result(false, [`decoder eval fault: ${message}`]);
    }

    if (
      out.flags.tapeExhausted === true ||
      out.flags.timeout === true ||
      out.flags.oom === true
    ) {
      return result(false, [
        `decoder eval fault: ${JSON.stringify(out.flags)}`,
      ]);
    }

    const consumedSeeds =
      out.consumed.random +
      out.consumed.date +
      out.consumed.time +
      out.consumed.crypto;

    if (consumedSeeds > 0) {
      return result(false, [
        `decoder consumed ${consumedSeeds} seeds — purity precondition failed, refuse`,
      ]);
    }

    const entries = parseJsonArray(out.ret);

    if (entries === null) {
      return result(false, ["decoder eval result unparsable"]);
    }

    if (entries.length !== reqs.length) {
      return result(false, ["decoder eval result shape mismatch"]);
    }

    // ---------- 4) 回填 ----------
    const { replaced, failed } = replaceCallSites(
      reqs,
      readEvalValues(entries)
    );

    if (replaced === 0) {
      return result(false, [`eval-failed=${failed}`]);
    }

    // ---------- 5) 清理无引用的别名声明（不动点迭代：别名链层层失效） ----------
    const aliasNames = new Set<string>();

    for (const name of varAliases.keys()) {
      if (resolveToDecoder(name) !== null) {
        aliasNames.add(name);
      }
    }

    removeDeadAliases(ast, aliasNames);

    // ---------- 5b) 清理无引用的包装函数（不动点） ----------
    const wrapperNames = new Set(wrappers.keys());

    removeDeadWrappers(ast, wrapperNames);

    // ---------- 6) prologue 移除判定 ----------
    // prologue 函数体/轮转 IIFE 之外的引用必须为 0。
    // 注意：存活的 wrapper/别名对 decoder 的引用【必须计数】——它们有真实调用点
    // （如非字面量实参），依赖链尚存，删 decoder 即 ReferenceError。
    const outsideRefs = countOutsidePrologueRefs(ast, prologueNames);

    const notes = [
      `inlined=${replaced}/${reqs.length}`,
      failed > 0 ? `eval-failed=${failed}` : "",
      `outside-refs=${outsideRefs}`,
      `aliases=${aliasNames.size}`,
    ].filter(Boolean);

    if (replaced > 0 && replaced === reqs.length && outsideRefs === 0) {
      stripPrologueStatements(ast, prologueNames);
      notes.push("prologue-removed");
    }

    return result(true, notes);
  },
};
