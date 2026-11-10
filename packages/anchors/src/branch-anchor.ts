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

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';

/** 条件分支节点形态（test 持有者） */
export type BranchKind = 'If' | 'Cond' | 'While' | 'DoWhile' | 'For';

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

/** 递归签名：节点类型 + 关键运算符；字面量→'#'，标识符→'_' */
export function shapeSig(node: t.Node | null | undefined): string {
  if (!node) return '';
  if (t.isLiteral(node)) return '#';
  if (t.isIdentifier(node)) return '_';
  if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
    return `(${node.operator}${shapeSig(node.left)},${shapeSig(node.right)})`;
  }
  if (t.isUnaryExpression(node)) return `(${node.operator}${shapeSig(node.argument)})`;
  if (t.isUpdateExpression(node)) return `(${node.operator}${shapeSig(node.argument)})`;
  if (t.isMemberExpression(node)) {
    return `${shapeSig(node.object)}${node.computed ? '[..]' : '.#'}`;
  }
  if (t.isCallExpression(node)) return `${shapeSig(node.callee)}(${node.arguments.map((a) => shapeSig(a)).join(',')})`;
  if (t.isConditionalExpression(node)) return `(?:${shapeSig(node.test)},${shapeSig(node.consequent)},${shapeSig(node.alternate)})`;
  if (t.isArrayExpression(node)) return `[${node.elements.map((e) => shapeSig(e)).join(',')}]`;
  if (t.isObjectExpression(node)) return `{${node.properties.length}}`;
  // 兜底：类型标签 + 有序子节点
  const kids: string[] = [];
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    const v = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && kids.push(shapeSig(c as t.Node)));
    else if (v && typeof v === 'object' && 'type' in v) kids.push(shapeSig(v as t.Node));
  }
  return `${node.type}(${kids.join(',')})`;
}

/* ======================== 分支节点收集 ======================== */

/** 收集全部非常量条件分支（含源码序出现次序） */
export function collectBranchNodes(ast: t.File): BranchNode[] {
  const out: BranchNode[] = [];
  const sigCount = new Map<string, number>();
  traverse(ast, {
    'IfStatement|ConditionalExpression|WhileStatement|DoWhileStatement|ForStatement'(path) {
      const node = path.node as unknown as { test?: t.Expression };
      const test = node.test;
      if (!test) return;
      const kind: BranchKind = t.isIfStatement(path.node) ? 'If'
        : t.isConditionalExpression(path.node) ? 'Cond'
        : t.isWhileStatement(path.node) ? 'While'
        : t.isDoWhileStatement(path.node) ? 'DoWhile' : 'For';
      // 常量测试跳过（fold 域，强测无意义）
      const evaluated = path.get('test').evaluate();
      if (evaluated.confident && typeof evaluated.value === 'boolean') return;

      const sig = `${kind}:${shapeSig(test)}`;
      const n = (sigCount.get(sig) ?? 0) + 1;
      sigCount.set(sig, n);

      let fnHint = '(top)';
      let p = path.parentPath;
      while (p) {
        if (p.isFunctionDeclaration() && p.node.id) { fnHint = p.node.id.name; break; }
        if ((p.isFunctionExpression() || p.isArrowFunctionExpression()) && p.parentPath?.isVariableDeclarator?.() && t.isIdentifier(p.parentPath.node.id)) {
          fnHint = p.parentPath.node.id.name;
          break;
        }
        p = p.parentPath;
      }
      out.push({
        kind,
        sig,
        fnHint,
        occurrence: n,
        line: test.loc?.start.line ?? 0,
        stmtLine: path.node.loc?.start.line ?? 0,
      });
    },
  });
  return out;
}

/** 由收集项 + 执行出现次序生成锚 */
export function anchorOf(node: BranchNode, execOccurrence: number): StructuralBranchAnchor {
  return { sig: node.sig, fnHint: node.fnHint, occurrence: node.occurrence, line: node.line, execOccurrence };
}

/* ======================== 分层匹配 ======================== */

export interface MatchResult {
  /** 匹配到的候选（nodes 索引）；null=失败（回退哨兵） */
  index: number | null;
  /** 匹配层级（诊断） */
  tier: 'exact' | 'sig+occ' | 'unique-sig' | 'none';
}

export function matchAnchor(anchor: StructuralBranchAnchor, nodes: BranchNode[]): MatchResult {
  // 层 1：sig + fnHint + occurrence
  const i1 = nodes.findIndex((n) => n.sig === anchor.sig && n.fnHint === anchor.fnHint && n.occurrence === anchor.occurrence);
  if (i1 >= 0) return { index: i1, tier: 'exact' };
  // 层 2：sig + occurrence（fnHint 因改名失配——demangle 等恒等改名）
  const i2 = nodes.findIndex((n) => n.sig === anchor.sig && n.occurrence === anchor.occurrence);
  if (i2 >= 0) return { index: i2, tier: 'sig+occ' };
  // 层 3：sig 全局唯一
  const bySig = nodes.map((n, i) => (n.sig === anchor.sig ? i : -1)).filter((i) => i >= 0);
  if (bySig.length === 1) return { index: bySig[0], tier: 'unique-sig' };
  return { index: null, tier: 'none' };
}

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

export function execOccurrencesOfTrace(lines: number[]): TraceLineEntry[] {
  const count = new Map<number, number>();
  return lines.map((line) => {
    const n = (count.get(line) ?? 0) + 1;
    count.set(line, n);
    return { line, execOccurrence: n };
  });
}

/**
 * 在候选分支节点集合 + 候选 trace 中，为锚点计算新的执行序号（1-based）。
 * 锚点在原代码中是"某节点的第 m 次执行"；候选代码中同结构节点的第 m 次
 * 执行位置即新序号。找不到返回 null。
 */
export function resolveForceIndex(
  anchor: StructuralBranchAnchor,
  nodes: BranchNode[],
  traceLines: number[],
): number | null {
  const m = matchAnchor(anchor, nodes);
  if (m.index === null) return null;
  const node = nodes[m.index];
  // 行匹配：test 行优先，其次语句行（引擎 find_line_num 可能挂任一）
  // 精确行匹配（test 行优先，其次语句行）——不做 ±1 容差：候选代码的 br 行号
  // 与其自身解析行号同源一致；容差会在相邻行分支间劫持锚（实测踩坑）
  const lines = execOccurrencesOfTrace(traceLines);
  let idx = lines.findIndex((e) => e.line === node.line && e.execOccurrence === anchor.execOccurrence);
  if (idx < 0) idx = lines.findIndex((e) => e.line === node.stmtLine && e.execOccurrence === anchor.execOccurrence);
  if (idx < 0) return null;
  return idx + 1; // 1-based 执行序
}
