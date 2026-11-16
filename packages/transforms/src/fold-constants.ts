/**
 * 常量折叠 + 字面量归一：
 *  - path.evaluate 折叠纯字面量子树（numbersToExpressions、字符串拼接、!![] 等）
 *  - !![] / ![] / !\{\} 等布尔混淆显式折叠
 *  - ConditionalExpression 常量测试折叠
 *  - 去除 extra.raw 强制规范化打印（hex 数字、unicode 转义归一）
 *
 * 工程注意：babel 在单次 traverse 中大量 replaceWith 会反复 requeue 撑爆调用栈
 * （实测 6k+ 次替换即溢出）。策略：只收集"顶层"可折叠节点（父节点可折叠则跳过，
 * 由父节点整体求值），traverse 结束后分批替换。
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

const BATCH = 1500;
const MAX_PASSES = 12;

/** path.evaluate 的值域：可回填成字面量节点的原始值 */
type LiteralValue = string | number | boolean | null | undefined;

/**
 * 原始值判定：求值产物是任意 JS 值，域只能靠运行时 typeof 判定
 * （非原始值的求值结果——函数/数组/正则——保持原样交给后续形态识别）。
 */
const isLiteralValue = (v: unknown): v is LiteralValue => {
  if (v === null || v === undefined) {
    return true;
  }

  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
};

/** 求值结果的数值形态 */
const isNumberValue = (v: unknown): v is number => typeof v === "number";

/** 求值结果的字符串形态 */
const isStringValue = (v: unknown): v is string => typeof v === "string";

/** 常量测试必须是 boolean 才能折叠 */
const isBooleanValue = (v: unknown): v is boolean => typeof v === "boolean";

const isFoldableExpr = (n: t.Node | null | undefined): boolean =>
  !!n &&
  (t.isBinaryExpression(n) ||
    t.isUnaryExpression(n) ||
    t.isLogicalExpression(n));

/** 字面量表达式的真值；非字面量返回 undefined（无法静态判定） */
const truthinessOf = (x: t.Expression): boolean | undefined => {
  if (t.isArrayExpression(x) || t.isObjectExpression(x)) {
    return true;
  }

  if (t.isNumericLiteral(x)) {
    return x.value !== 0;
  }

  if (t.isStringLiteral(x)) {
    return x.value.length > 0;
  }

  return undefined;
};

/** 显式布尔混淆模式：![] / !![] / !\{\} / !!\{\} / !0 / !1 */
const foldExplicitBoolean = (path: NodePath): boolean => {
  const n = path.node;

  if (!t.isUnaryExpression(n) || n.operator !== "!") {
    return false;
  }

  const a = n.argument;

  // !!x ≡ Boolean(x)（双重取反 = 真值本身）
  if (t.isUnaryExpression(a) && a.operator === "!") {
    const inner = truthinessOf(a.argument);

    if (inner !== undefined) {
      path.replaceWith(t.booleanLiteral(inner));

      return true;
    }
  }

  const direct = truthinessOf(a);

  if (direct !== undefined) {
    path.replaceWith(t.booleanLiteral(!direct));

    return true;
  }

  return false;
};

/** 字面量 raw 清理（hex 数字、unicode 转义归一）——返回清理计数 */
const normalizeRawLiterals = (ast: t.File): number => {
  let normalized = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const batch: NodePath[] = [];

    traverse(ast, {
      "StringLiteral|NumericLiteral"(path) {
        if (batch.length >= BATCH) {
          return;
        }

        if (path.node.extra) {
          batch.push(path);
        }
      },
    });

    if (batch.length === 0) {
      break;
    }

    for (const p of batch) {
      // 祖先替换可能已使该路径失效
      if (p.node === null || p.node === undefined) {
        continue;
      }

      const n = p.node;

      // 该 visitor 只收 StringLiteral / NumericLiteral，此守卫与原断言等价
      if (t.isStringLiteral(n) || t.isNumericLiteral(n)) {
        delete n.extra;
      }

      normalized += 1;
    }
  }

  return normalized;
};

/** 纯字面量子树折叠（path.evaluate）——返回折叠计数 */
const foldLiteralSubtrees = (ast: t.File): number => {
  let folded = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const batch: { path: NodePath; value: unknown }[] = [];

    traverse(ast, {
      "BinaryExpression|UnaryExpression|LogicalExpression"(path) {
        if (batch.length >= BATCH) {
          return;
        }

        // 顶层优先：父节点也可折叠时跳过（父子不重叠，避免替换竞争）
        if (isFoldableExpr(path.parentPath?.node)) {
          return;
        }

        const res = path.evaluate();

        if (!res.confident || !isLiteralValue(res.value)) {
          return;
        }

        const n = path.node;

        if (
          t.isNumericLiteral(n) &&
          isNumberValue(res.value) &&
          n.value === res.value
        ) {
          return;
        }

        if (
          t.isStringLiteral(n) &&
          isStringValue(res.value) &&
          n.value === res.value
        ) {
          return;
        }

        batch.push({ path, value: res.value });
      },
    });

    if (batch.length === 0) {
      break;
    }

    for (const job of batch) {
      // 祖先替换可能已使该路径失效
      if (job.path.node === null || job.path.node === undefined) {
        continue;
      }

      try {
        job.path.replaceWith(t.valueToNode(job.value));
        folded += 1;
      } catch {
        /* 特殊值跳过 */
      }
    }
  }

  return folded;
};

/** 布尔混淆（![]/!![]）折叠：规模小，直接在 visitor 内替换——返回折叠计数 */
const foldBooleanObscuring = (ast: t.File): number => {
  let boolCount = 0;

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- babel traverse 的 visitor 键必须是 AST 节点类型名
    UnaryExpression(path) {
      if (boolCount > BATCH) {
        return;
      }

      if (foldExplicitBoolean(path)) {
        boolCount += 1;
      }
    },
  });

  return boolCount;
};

/** 条件表达式常量测试折叠——返回折叠计数 */
const foldConstantConditionals = (ast: t.File): number => {
  let folded = 0;

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const batch: { keep: t.Expression; path: NodePath }[] = [];

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- babel traverse 的 visitor 键必须是 AST 节点类型名
      ConditionalExpression(path) {
        if (batch.length >= BATCH) {
          return;
        }

        const testRes = path.get("test").evaluate();

        if (!testRes.confident || !isBooleanValue(testRes.value)) {
          return;
        }

        batch.push({
          keep: testRes.value ? path.node.consequent : path.node.alternate,
          path,
        });
      },
    });

    if (batch.length === 0) {
      break;
    }

    for (const job of batch) {
      // 祖先替换可能已使该路径失效
      if (job.path.node === null || job.path.node === undefined) {
        continue;
      }

      try {
        job.path.replaceWith(job.keep);
        folded += 1;
      } catch {
        /* skip */
      }
    }
  }

  return folded;
};

export const foldConstants: Transform = {
  name: "fold-constants",
  risk: "safe",
  // oxlint-disable-next-line eslint/require-await -- Transform.run 契约返回 Promise，本变换全同步；保留 async 才能让内部异常走 rejected promise（同步返回会改变 governor 的异常路径）
  async run(ast) {
    // 顺序即语义：raw 归一 → 子树折叠 → 布尔折叠 → 条件折叠
    const normalized = normalizeRawLiterals(ast);
    const subtreeFolded = foldLiteralSubtrees(ast);
    const boolCount = foldBooleanObscuring(ast);
    const conditionalFolded = foldConstantConditionals(ast);
    const folded = subtreeFolded + conditionalFolded;

    return result(folded > 0 || normalized > 0, [
      `folded=${folded}`,
      `bool-folded=${boolCount}`,
      `raw-normalized=${normalized}`,
    ]);
  },
};
