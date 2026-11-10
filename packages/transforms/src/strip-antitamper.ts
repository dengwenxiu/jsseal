/**
 * 反篡改机制剥离（self-defending / debug protection）：
 *  封闭运行时里它们已被中和（toString 钉死 + debugger no-op），本变换只做可读性剥离，
 *  行为等价性由锚库把关。
 *
 *  1. debugProtection：包含 'debugger'（DebuggerStatement 或 Function('debugger')）的语句
 *     及其定义名的调用语句 → 删除
 *  2. self-defending：toString 自检（含 '\n' 检测）+ while(true) 惩罚循环 → 删除
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';

interface SubtreeHit {
  hasDebugger: boolean;
  hasFormatCheck: boolean;
  hasPunishLoop: boolean;
  definedNames: Set<string>;
}

function scanSubtree(root: t.Node): SubtreeHit {
  const hit: SubtreeHit = { hasDebugger: false, hasFormatCheck: false, hasPunishLoop: false, definedNames: new Set() };
  const walk = (n: t.Node): void => {
    if (!n || typeof n !== 'object') return;
    if (t.isDebuggerStatement(n)) hit.hasDebugger = true;
    if (t.isStringLiteral(n) && n.value === 'debugger') hit.hasDebugger = true;
    if (
      t.isCallExpression(n) &&
      t.isMemberExpression(n.callee) &&
      t.isIdentifier(n.callee.property) &&
      (n.callee.property.name === 'test' || n.callee.property.name === 'includes' || n.callee.property.name === 'indexOf')
    ) {
      // 格式检测：test/includes/indexOf 与换行/空白字符串组合
      for (const arg of n.arguments) {
        if (t.isStringLiteral(arg) && /\\n|\n|\r|\t|\s{2,}/.test(arg.value)) hit.hasFormatCheck = true;
      }
      const obj = n.callee.object;
      if (t.isRegExpLiteral(obj) && /\\n|\s/.test(obj.pattern)) hit.hasFormatCheck = true;
    }
    if (t.isRegExpLiteral(n) && /\\n/.test(n.pattern)) hit.hasFormatCheck = true;
    if (t.isWhileStatement(n) && t.isBooleanLiteral(n.test) && n.test.value === true) hit.hasPunishLoop = true;
    if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) hit.definedNames.add(n.id.name);
    if (t.isFunctionDeclaration(n) && n.id) hit.definedNames.add(n.id.name);
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const v = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && walk(c as t.Node));
      else if (v && typeof v === 'object' && 'type' in (v as object)) walk(v as t.Node);
    }
  };
  walk(root);
  return hit;
}

export const stripAntitamper: Transform = {
  name: 'strip-antitamper',
  risk: 'unsafe',
  async run(ast) {
    let removed = 0;
    const notes: string[] = [];

    // 收集需要删除的语句路径 + 定义名集合
    const stmtPaths: Array<import('@babel/traverse').NodePath<t.Statement>> = [];
    const definedNames = new Set<string>();

    traverse(ast, {
      Statement(path) {
        // 只处理"语句级"节点：直接父级也是语句/Program
        if (!path.parentPath || (!path.parentPath.isProgram() && !path.parentPath.isStatement() && !path.parentPath.isBlockStatement?.())) return;
        // 避免嵌套重复收集：跳过子语句已命中父语句的情况——通过扫描范围去重
        const hit = scanSubtree(path.node);
        const isDebug = hit.hasDebugger;
        const isSelfDefending = hit.hasFormatCheck && hit.hasPunishLoop;
        if (!isDebug && !isSelfDefending) return;
        // self-defending 判定需含 toString 使用（减少误杀）
        if (isSelfDefending && !usesToString(path.node)) return;
        stmtPaths.push(path as import('@babel/traverse').NodePath<t.Statement>);
        for (const n of hit.definedNames) definedNames.add(n);
      },
    });

    // 去重：被更大范围覆盖的语句跳过（按 start 范围）
    const ranges = stmtPaths
      .map((p) => ({ p, start: p.node.start ?? -1, end: p.node.end ?? -1 }))
      .sort((a, b) => a.start - b.start);
    const keep: typeof ranges = [];
    for (const r of ranges) {
      const covered = keep.some((k) => r.start >= k.start && r.end <= k.end);
      if (!covered) keep.push(r);
    }

    for (const { p } of keep) {
      try {
        p.remove();
        removed++;
      } catch {
        /* skip */
      }
    }

    // 删除被剥离定义的所有调用语句（ExpressionStatement 引用定义名）
    if (definedNames.size > 0 && removed > 0) {
      let callRemoved = 0;
      traverse(ast, {
        ExpressionStatement(path) {
          let refs = false;
          path.traverse({
            Identifier(ip) {
              if (definedNames.has(ip.node.name)) refs = true;
            },
          });
          if (refs) {
            path.remove();
            callRemoved++;
          }
        },
      });
      if (callRemoved > 0) notes.push(`call-sites-removed=${callRemoved}`);
    }

    return result(removed > 0, [`statements-removed=${removed}`, ...notes]);
  },
};

function usesToString(node: t.Node): boolean {
  let found = false;
  const walk = (n: t.Node): void => {
    if (found || !n || typeof n !== 'object') return;
    if (
      t.isMemberExpression(n) &&
      t.isIdentifier(n.property) &&
      n.property.name === 'toString'
    ) {
      found = true;
      return;
    }
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      const v = (n as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c === 'object' && 'type' in c && walk(c as t.Node));
      else if (v && typeof v === 'object' && 'type' in (v as object)) walk(v as t.Node);
    }
  };
  walk(node);
  return found;
}
