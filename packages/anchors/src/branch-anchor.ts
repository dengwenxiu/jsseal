/**
 * AST 路径锚定 v2（结构锚）——强制分支从"序号锚定"升级为"结构锚定"：
 *
 * v1 的三个问题：
 * 1. fps[k-1] 概念混用：k 是**执行序**，fps 是**静态源码序**——仅顺序执行时恰好相等
 * 2. 文本指纹（打印文本去空白）在恒等改写下失配：0x10→16、!![]→true、
 *    重命名、格式化——锚点丢失即回退，覆盖缩水
 * 3. 验证退化 ok-only：序号漂移下全比对必误报——正确分支锚定后全比对才成立
 *
 * v2 结构锚 = (形状签名, 函数提示, 出现次序)：
 * - **形状签名**：递归节点类型签名，字面量占位 `#`——`x>0x10` 与 `x>16` 同签名，
 *   重命名（标识符统一占位 `_`）后仍同签名；结构重写（如真值折叠改变量型）
 *   才失配（正确保守）
 * - **函数提示**：最近包围函数名（分层匹配用，demangle 改名后失配→降级）
 * - **出现次序**：同签名源码序第 n 次出现——唯一化重复模式
 *
 * 匹配分层：精确(sig+fn+occ) → 降级(sig+occ) → 唯一 sig；歧义/失败 → null
 * （调用方回退 ok-only 哨兵，即 v1 行为）。
 */

import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";
import type { NodePath } from "@jsseal/ast";

/** 条件分支节点形态（test 持有者） */
export type BranchKind = "If" | "Cond" | "While" | "DoWhile" | "For";

export interface BranchNode {
  kind: BranchKind;
  /** 形状签名（字面量/标识符占位） */
  sig: string;
  /** 最近包围函数名；顶层为 '(top)' */
  fnHint: string;
  /** 同 sig 源码序出现次序（1-based） */
  occurrence: number;
  /** test 起始行（与 br trace 的 find_line_num 对齐） */
  line: number;
  /** 语句/表达式起始行（Some 引擎把行号挂在语句上） */
  stmtLine: number;
}

export interface StructuralBranchAnchor {
  sig: string;
  fnHint: string;
  occurrence: number;
  line: number;
  /** 该分支在执行序列中的出现次序（1-based，循环内多次执行时区分） */
  execOccurrence: number;
}

/* ======================== 形状签名 ======================== */

/** VISITOR_KEYS 声明的子槽位取值：单子节点 | 子节点数组 | 空槽 */
type VisitorSlot = t.Node | (t.Node | null | undefined)[] | null | undefined;

/**
 * 按 VISITOR_KEYS 的键取子槽位值。\@babel/types 的 Node 联合没有通用索引签名，
 * 动态键访问无法在类型层表达——运行时契约由 VISITOR_KEYS 自己给出。
 */
const visitorSlotAt = (node: t.Node, key: string): VisitorSlot =>
  // SAFETY: key 取自 t.VISITOR_KEYS[node.type]，该键在 Babel 节点上只持有子节点槽位
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Node 联合无法用单次 as 跨到槽位表（缺索引签名），只能经 unknown 两跳
  (node as unknown as Record<string, VisitorSlot>)[key];

/** 槽位 → 子节点列表（数组槽位按声明序展开，空槽不产子节点） */
const childNodesOf = (slot: VisitorSlot): t.Node[] => {
  if (Array.isArray(slot)) {
    return slot.filter(t.isNode);
  }

  return t.isNode(slot) ? [slot] : [];
};

/** 递归签名：节点类型 + 关键运算符；字面量→'#'，标识符→'_' */
export const signatureOf = (node: t.Node | null | undefined): string => {
  if (!node) {
    return "";
  }

  if (t.isLiteral(node)) {
    return "#";
  }

  if (t.isIdentifier(node)) {
    return "_";
  }

  if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
    return `(${node.operator}${signatureOf(node.left)},${signatureOf(node.right)})`;
  }

  if (t.isUnaryExpression(node)) {
    return `(${node.operator}${signatureOf(node.argument)})`;
  }

  if (t.isUpdateExpression(node)) {
    return `(${node.operator}${signatureOf(node.argument)})`;
  }

  if (t.isMemberExpression(node)) {
    return `${signatureOf(node.object)}${node.computed ? "[..]" : ".#"}`;
  }

  if (t.isCallExpression(node)) {
    return `${signatureOf(node.callee)}(${node.arguments.map((a) => signatureOf(a)).join(",")})`;
  }

  if (t.isConditionalExpression(node)) {
    return `(?:${signatureOf(node.test)},${signatureOf(node.consequent)},${signatureOf(node.alternate)})`;
  }

  if (t.isArrayExpression(node)) {
    return `[${node.elements.map((e) => signatureOf(e)).join(",")}]`;
  }

  if (t.isObjectExpression(node)) {
    return `{${node.properties.length}}`;
  }

  // 兜底：类型标签 + 有序子节点
  const kids: string[] = [];

  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    for (const child of childNodesOf(visitorSlotAt(node, key))) {
      kids.push(signatureOf(child));
    }
  }

  return `${node.type}(${kids.join(",")})`;
};

/* ======================== 分支节点收集 ======================== */

/** 分支节点 → (种类, test 表达式)；非分支返回 null */
const branchTestOf = (
  node: t.Node
): { kind: BranchKind; test: t.Expression } | null => {
  if (t.isIfStatement(node)) {
    return { kind: "If", test: node.test };
  }

  if (t.isConditionalExpression(node)) {
    return { kind: "Cond", test: node.test };
  }

  if (t.isWhileStatement(node)) {
    return { kind: "While", test: node.test };
  }

  if (t.isDoWhileStatement(node)) {
    return { kind: "DoWhile", test: node.test };
  }

  if (t.isForStatement(node) && t.isExpression(node.test)) {
    return { kind: "For", test: node.test };
  }

  return null;
};

/** 最近包围函数名（分层匹配用）；顶层为 '(top)' */
const enclosingFunctionName = (path: NodePath): string => {
  let p = path.parentPath;

  while (p) {
    if (p.isFunctionDeclaration() && p.node.id) {
      return p.node.id.name;
    }

    if (
      (p.isFunctionExpression() || p.isArrowFunctionExpression()) &&
      p.parentPath?.isVariableDeclarator?.() &&
      t.isIdentifier(p.parentPath.node.id)
    ) {
      return p.parentPath.node.id.name;
    }

    p = p.parentPath;
  }

  return "(top)";
};

/** 收集全部非常量条件分支（含源码序出现次序） */
export const collectBranchNodes = (ast: t.File): BranchNode[] => {
  const out: BranchNode[] = [];
  const sigCount = new Map<string, number>();

  traverse(ast, {
    "IfStatement|ConditionalExpression|WhileStatement|DoWhileStatement|ForStatement"(
      path
    ) {
      const branch = branchTestOf(path.node);

      if (branch === null) {
        return;
      }

      // 常量测试跳过（fold 域，强测无意义）
      const evaluated = path.get("test").evaluate();

      if (
        evaluated.confident &&
        (evaluated.value === true || evaluated.value === false)
      ) {
        return;
      }

      const sig = `${branch.kind}:${signatureOf(branch.test)}`;
      const n = (sigCount.get(sig) ?? 0) + 1;

      sigCount.set(sig, n);

      out.push({
        sig,
        fnHint: enclosingFunctionName(path),
        kind: branch.kind,
        line: branch.test.loc?.start.line ?? 0,
        stmtLine: path.node.loc?.start.line ?? 0,
        occurrence: n,
      });
    },
  });

  return out;
};

/** 由收集项 + 执行出现次序生成锚 */
export const anchorOf = (
  node: BranchNode,
  execOccurrence: number
): StructuralBranchAnchor => ({
  sig: node.sig,
  fnHint: node.fnHint,
  occurrence: node.occurrence,
  line: node.line,
  execOccurrence,
});

/* ======================== 分层匹配 ======================== */

/** 匹配层级（诊断）：精确 → 降级 sig+occ → 唯一 sig → 失败 */
export type MatchTier = "exact" | "sig+occ" | "unique-sig" | "none";

export interface MatchResult {
  /** 匹配到的候选（nodes 索引）；null=失败（回退哨兵） */
  index: number | null;
  /** 匹配层级（诊断） */
  tier: MatchTier;
}

export const matchAnchor = (
  anchor: StructuralBranchAnchor,
  nodes: BranchNode[]
): MatchResult => {
  // 层 1：sig + fnHint + occurrence
  const i1 = nodes.findIndex(
    (n) =>
      n.sig === anchor.sig &&
      n.fnHint === anchor.fnHint &&
      n.occurrence === anchor.occurrence
  );

  if (i1 !== -1) {
    return { index: i1, tier: "exact" };
  }

  // 层 2：sig + occurrence（fnHint 因改名失配——demangle 等恒等改名）
  const i2 = nodes.findIndex(
    (n) => n.sig === anchor.sig && n.occurrence === anchor.occurrence
  );

  if (i2 !== -1) {
    return { index: i2, tier: "sig+occ" };
  }

  // 层 3：sig 全局唯一
  const bySig: number[] = [];

  for (const [i, n] of nodes.entries()) {
    if (n.sig === anchor.sig) {
      bySig.push(i);
    }
  }

  if (bySig.length === 1) {
    return { index: bySig[0], tier: "unique-sig" };
  }

  return { index: null, tier: "none" };
};

/* ======================== 执行序定位 ======================== */

/**
 * br trace 事件（行号）序列 → 各行的执行出现次序配对。
 * 返回：行号 → 该行作为被执行分支的第 m 次出现（累计）数组，按执行序。
 */
export interface TraceLineEntry {
  line: number;
  /** 该行第几次执行（1-based，同行多次=循环/重复调用） */
  execOccurrence: number;
}

export const execOccurrencesOfTrace = (lines: number[]): TraceLineEntry[] => {
  const count = new Map<number, number>();

  return lines.map((line) => {
    const n = (count.get(line) ?? 0) + 1;

    count.set(line, n);

    return { line, execOccurrence: n };
  });
};

/**
 * 在候选分支节点集合 + 候选 trace 中，为锚点计算新的执行序号（1-based）。
 * 锚点在原代码中是"某节点的第 m 次执行"；候选代码中同结构节点的第 m 次
 * 执行位置即新序号。找不到返回 null。
 */
export const resolveForceIndex = (
  anchor: StructuralBranchAnchor,
  nodes: BranchNode[],
  traceLines: number[]
): number | null => {
  const m = matchAnchor(anchor, nodes);

  if (m.index === null) {
    return null;
  }

  const node = nodes[m.index];

  // 行匹配：test 行优先，其次语句行（引擎 find_line_num 可能挂任一）
  // 精确行匹配（test 行优先，其次语句行）——不做 ±1 容差：候选代码的 br 行号
  // 与其自身解析行号同源一致；容差会在相邻行分支间劫持锚（实测踩坑）
  const lines = execOccurrencesOfTrace(traceLines);

  let idx = lines.findIndex(
    (e) => e.line === node.line && e.execOccurrence === anchor.execOccurrence
  );

  if (idx < 0) {
    idx = lines.findIndex(
      (e) =>
        e.line === node.stmtLine && e.execOccurrence === anchor.execOccurrence
    );
  }

  if (idx < 0) {
    return null;
  }

  // 1-based 执行序
  return idx + 1;
};
