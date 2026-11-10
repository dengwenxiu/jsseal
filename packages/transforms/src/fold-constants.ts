/**
 * 常量折叠 + 字面量归一：
 *  - path.evaluate 折叠纯字面量子树（numbersToExpressions、字符串拼接、!![] 等）
 *  - !![] / ![] / !!{} 等布尔混淆显式折叠
 *  - ConditionalExpression 常量测试折叠
 *  - 去除 extra.raw 强制规范化打印（hex 数字、unicode 转义归一）
 *
 * 工程注意：babel 在单次 traverse 中大量 replaceWith 会反复 requeue 撑爆调用栈
 * （实测 6k+ 次替换即溢出）。策略：只收集"顶层"可折叠节点（父节点可折叠则跳过，
 * 由父节点整体求值），traverse 结束后分批替换。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import type { NodePath } from '@babel/traverse';
import { result, type Transform } from './types';

function literalish(v: unknown): boolean {
  return v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
}

function isFoldableExpr(n: t.Node | null | undefined): boolean {
  return !!n && (t.isBinaryExpression(n) || t.isUnaryExpression(n) || t.isLogicalExpression(n));
}

/** 显式布尔混淆模式：![] / !![] / !{} / !!{} / !0 / !1 */
function foldExplicitBoolean(path: NodePath): boolean {
  const n = path.node as t.Node;
  if (!t.isUnaryExpression(n) || n.operator !== '!') return false;
  const a = n.argument;
  const truthiness = (x: t.Expression): boolean | undefined => {
    if (t.isArrayExpression(x) || t.isObjectExpression(x)) return true;
    if (t.isNumericLiteral(x)) return x.value !== 0;
    if (t.isStringLiteral(x)) return x.value.length > 0;
    return undefined;
  };
  // !!x ≡ Boolean(x)（双重取反 = 真值本身）
  if (t.isUnaryExpression(a) && a.operator === '!') {
    const inner = truthiness(a.argument);
    if (inner !== undefined) {
      path.replaceWith(t.booleanLiteral(inner));
      return true;
    }
  }
  const direct = truthiness(a);
  if (direct !== undefined) {
    path.replaceWith(t.booleanLiteral(!direct));
    return true;
  }
  return false;
}

const BATCH = 1500;
const MAX_PASSES = 12;

export const foldConstants: Transform = {
  name: 'fold-constants',
  risk: 'safe',
  async run(ast) {
    let folded = 0;
    let normalized = 0;

    // 字面量规范化（raw 清理也分批，避免同类问题）
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const batch: NodePath[] = [];
      traverse(ast, {
        'StringLiteral|NumericLiteral'(path) {
          if (batch.length >= BATCH) return;
          if (path.node.extra) batch.push(path);
        },
      });
      if (batch.length === 0) break;
      for (const p of batch) {
        if (!p.node) continue;
        delete (p.node as t.StringLiteral | t.NumericLiteral).extra;
        normalized++;
      }
    }

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const batch: Array<{ path: NodePath; value: unknown }> = [];
      traverse(ast, {
        'BinaryExpression|UnaryExpression|LogicalExpression'(path) {
          if (batch.length >= BATCH) return;
          // 顶层优先：父节点也可折叠时跳过（父子不重叠，避免替换竞争）
          if (isFoldableExpr(path.parentPath?.node)) return;
          const res = path.evaluate();
          if (!res.confident || !literalish(res.value)) return;
          const n = path.node;
          if (t.isNumericLiteral(n) && typeof res.value === 'number' && n.value === res.value) return;
          if (t.isStringLiteral(n) && typeof res.value === 'string' && n.value === res.value) return;
          batch.push({ path, value: res.value });
        },
      });
      if (batch.length === 0) break;
      for (const { path, value } of batch) {
        if (!path.node) continue; // 祖先替换可能已使该路径失效
        try {
          path.replaceWith(t.valueToNode(value));
          folded++;
        } catch {
          /* 特殊值跳过 */
        }
      }
    }

    // 布尔混淆（![]/!![]）小规模，直接在 visitor 内替换
    let boolCount = 0;
    traverse(ast, {
      UnaryExpression(path) {
        if (boolCount > BATCH) return;
        if (foldExplicitBoolean(path)) boolCount++;
      },
    });

    // 条件表达式常量测试
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const batch: NodePath[] = [];
      traverse(ast, {
        ConditionalExpression(path) {
          if (batch.length >= BATCH) return;
          const testRes = path.get('test').evaluate();
          if (!testRes.confident || typeof testRes.value !== 'boolean') return;
          batch.push(path);
          (path as unknown as { __keep?: t.Expression }).__keep = testRes.value ? path.node.consequent : path.node.alternate;
        },
      });
      if (batch.length === 0) break;
      for (const p of batch) {
        const keep = (p as unknown as { __keep?: t.Expression }).__keep;
        if (!p.node || !keep) continue;
        try {
          p.replaceWith(keep);
          folded++;
        } catch {
          /* skip */
        }
      }
    }

    return result(folded > 0 || normalized > 0, [`folded=${folded}`, `bool-folded=${boolCount}`, `raw-normalized=${normalized}`]);
  },
};
