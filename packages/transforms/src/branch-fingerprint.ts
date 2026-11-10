/**
 * AST 路径锚定（forced execution 的结构身份匹配）：
 *
 * 问题：当前强制锚定用"第 k 个执行的条件分支"（执行序号），但死代码消除/CFF 还原
 * 等结构变换会改变分支序列 → 序号漂移 → 健康哨兵误报。
 *
 * 方案：用分支测试表达式的 **AST 结构指纹** 作为身份标识——
 * 语义恒等变换不改变测试表达式的内容（只可能改变位置/格式），
 * 指纹在变换前后稳定 → 强制锚点可精确映射。
 *
 * 指纹 = hash(test 表达式的 AST 形状，忽略 loc/标识符名/字面量值的具体内容，
 * 保留节点类型与结构)——保守做法：直接用 test 的打印文本（去空白）作为指纹，
 * 因为恒等变换不改语义内容。
 */

import * as t from '@babel/types';
import { printCode, traverse } from '@jsseal/ast';

export interface BranchFingerprint {
  /** 测试表达式的规范化文本（去空白/分号） */
  hash: string;
  /** 在原代码中的行号（调试用） */
  line: number;
}

/** 提取所有条件分支的指纹 */
export function extractBranchFingerprints(ast: t.File): BranchFingerprint[] {
  const fingerprints: BranchFingerprint[] = [];
  traverse(ast, {
    'IfStatement|ConditionalExpression|WhileStatement|DoWhileStatement|ForStatement'(path) {
      const test = (path.node as unknown as { test?: t.Expression }).test;
      if (!test) return;
      // 常量测试无需强制（fold 已处理）
      const res = path.get('test').evaluate();
      if (res.confident && typeof res.value === 'boolean') return;
      // 指纹 = 打印文本去空白
      const text = printCode(test).replace(/\s+/g, '');
      const line = test.loc?.start.line ?? 0;
      fingerprints.push({ hash: text, line });
    },
  });
  return fingerprints;
}

/**
 * 在变换后的代码中查找与原指纹匹配的分支。
 * 匹配策略：精确指纹 → 前缀匹配（截断到 120 字符以容忍微小的表达式包装差异）
 */
export function matchFingerprint(
  target: BranchFingerprint,
  candidates: BranchFingerprint[],
): number {
  const targetHash = target.hash.slice(0, 120);
  // 1. 精确匹配
  const exact = candidates.findIndex((c) => c.hash === target.hash);
  if (exact >= 0) return exact;
  // 2. 前缀匹配（前 120 字符）
  const prefix = candidates.findIndex((c) => c.hash.slice(0, 120) === targetHash);
  return prefix;
}

/**
 * 构建指纹→执行序号的映射（用于强制锚点的身份迁移）：
 * 在原代码上记录 (指纹, 执行序号)，变换后在候选代码上用指纹找到对应分支的新序号。
 */
export interface ForcedAnchorMigration {
  /** 原代码中的指纹列表（有序） */
  originalFingerprints: BranchFingerprint[];
  /** 变换后代码中的指纹列表（有序） */
  transformedFingerprints: BranchFingerprint[];
  /** 原序号 → 变换后序号的映射 */
  mapping: Map<number, number>;
}

export function buildMigration(
  originalAst: t.File,
  transformedAst: t.File,
): ForcedAnchorMigration {
  const originalFingerprints = extractBranchFingerprints(originalAst);
  const transformedFingerprints = extractBranchFingerprints(transformedAst);
  const mapping = new Map<number, number>();

  for (let origIdx = 0; origIdx < originalFingerprints.length; origIdx++) {
    const transformedIdx = matchFingerprint(originalFingerprints[origIdx], transformedFingerprints);
    if (transformedIdx >= 0) {
      mapping.set(origIdx + 1, transformedIdx + 1); // 1-based 序号
    }
  }

  return { originalFingerprints, transformedFingerprints, mapping };
}
