/**
 * 控制流扁平化还原（obfuscator.io switch-dispatcher 标准形）：
 *
 *   var seq = '0|3|1|2'.split('|'), i = 0;
 *   while (!![]) {
 *     switch (seq[i++]) {
 *       case '0': ...; continue;
 *       case '3': ...; continue;
 *       ...
 *     }
 *     break;
 *   }
 *
 * → 按序重排 case 体，删除分发器。case 体内含裸 break/continue 时放弃（保守）。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';

function truthyLike(test: t.Expression): boolean {
  if (t.isBooleanLiteral(test)) return test.value;
  if (t.isUnaryExpression(test) && test.operator === '!') {
    const a = test.argument;
    if (t.isUnaryExpression(a) && a.operator === '!' && (t.isArrayExpression(a.argument) || t.isObjectExpression(a.argument))) {
      return true;
    }
  }
  return false;
}

function containsBareJump(node: t.Node): boolean {
  let found = false;
  const walk = (n: t.Node): void => {
    if (!n || typeof n !== 'object' || found) return;
    if (t.isContinueStatement(n) && !n.label) {
      // 属于外层 while 的裸 continue
      found = true;
      return;
    }
    if (t.isBreakStatement(n) && !n.label) {
      // 内层 switch/break 合法——只标记"直接位于 case 体"的裸 break 由调用方处理；
      // 这里无法区分层级，保守视为复杂跳转
      found = true;
      return;
    }
    if (t.isForStatement(n) || t.isWhileStatement(n) || t.isDoWhileStatement(n) || t.isSwitchStatement(n)) {
      // 循环/switch 内部的 break 属于该结构，不干扰外层——跳过其子树
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

/** 查找 seq 声明：var seq = 'a|b|c'.split('|')（或任意字符串字面量 split） */
function findSeqDecl(
  whilePath: import('@babel/traverse').NodePath<t.WhileStatement>,
  seqName: string,
): { declPath: import('@babel/traverse').NodePath<t.VariableDeclarator>; order: string[] } | null {
  let found: { declPath: import('@babel/traverse').NodePath<t.VariableDeclarator>; order: string[] } | null = null;
  let wp: import('@babel/traverse').NodePath | null = whilePath.parentPath;
  while (wp && !found) {
    const scopeRoot = wp;
    scopeRoot.traverse({
      VariableDeclarator(dp) {
        if (found) return;
        const id = dp.node.id;
        if (!t.isIdentifier(id) || id.name !== seqName) return;
        const init = dp.node.init;
        if (!init || !t.isCallExpression(init)) return;
        if (!t.isMemberExpression(init.callee) || !t.isIdentifier(init.callee.property) || init.callee.property.name !== 'split') return;
        const sepArg = init.arguments[0];
        const sep = t.isStringLiteral(sepArg) ? sepArg.value : undefined;
        if (sep !== '|') return;
        const obj = init.callee.object;
        let orderStr: string | null = null;
        if (t.isStringLiteral(obj)) {
          orderStr = obj.value;
        } else {
          // 顺序串藏在常量成员里（对象映射 {'xJszW': '0|1|2|...'}）——求值解析
          try {
            const objPath = dp.get('init');
            const memberPath = (objPath as import('@babel/traverse').NodePath).get('callee.object');
            const res = (memberPath as import('@babel/traverse').NodePath).evaluate();
            if (res.confident && typeof res.value === 'string') orderStr = res.value;
          } catch {
            /* ignore */
          }
        }
        if (orderStr === null) return;
        found = { declPath: dp, order: orderStr.split('|') };
      },
    });
    wp = wp.parentPath;
  }
  return found;
}

export const unflattenCff: Transform = {
  name: 'unflatten-cff',
  risk: 'unsafe',
  async run(ast) {
    let count = 0;
    const notes: string[] = [];

    const tryUnflatten = (path: import('@babel/traverse').NodePath<t.WhileStatement>): boolean => {
      const node = path.node;
      if (!truthyLike(node.test as t.Expression)) return false;

      // body 必须是 { switch, (break)? } 或直接 switch
      let body: readonly t.Statement[];
      if (t.isBlockStatement(node.body)) body = node.body.body;
      else body = [node.body];
      const sw = body.find((s) => t.isSwitchStatement(s)) as t.SwitchStatement | undefined;
      if (!sw || body.filter((s) => s !== sw).some((s) => !t.isBreakStatement(s))) return false;

      // discrim: seq[i++]
      const d = sw.discriminant;
      if (!t.isMemberExpression(d) || !d.computed || !t.isIdentifier(d.object)) return false;
      if (!t.isUpdateExpression(d.property) || d.property.operator !== '++' || !t.isIdentifier(d.property.argument)) return false;
      const seqName = d.object.name;

      const seq = findSeqDecl(path, seqName);
      if (!seq) return false;

      // case 收集
      const caseMap = new Map<string, t.Statement[]>();
      for (const c of sw.cases) {
        if (!c.test || !t.isStringLiteral(c.test)) return false; // default/非常量 → 放弃
        const stmts = [...c.consequent];
        const last = stmts[stmts.length - 1];
        if (last && t.isContinueStatement(last) && !last.label) stmts.pop();
        for (const s of stmts) {
          if (containsBareJump(s)) return false;
        }
        caseMap.set(c.test.value, stmts);
      }

      // 按序重排
      const out: t.Statement[] = [];
      for (const key of seq.order) {
        const stmts = caseMap.get(key);
        if (!stmts) return false;
        out.push(...stmts);
      }

      const declPath = seq.declPath;
      path.replaceWith(t.blockStatement(out));
      // 删除 seq declarator（若所属声明只剩它则整句删除）
      try {
        declPath.remove();
      } catch {
        /* 已被移除 */
      }
      return true;
    };

    const targets: Array<import('@babel/traverse').NodePath<t.WhileStatement>> = [];
    traverse(ast, {
      WhileStatement(path) {
        if (truthyLike(path.node.test as t.Expression)) {
          const body = path.node.body;
          const stmts = t.isBlockStatement(body) ? body.body : [body];
          if (stmts.some((s) => t.isSwitchStatement(s))) targets.push(path);
        }
      },
    });
    for (const target of targets) {
      if (!target.node) continue; // 前续替换可能已使其失效
      try {
        if (tryUnflatten(target)) count++;
      } catch (e) {
        notes.push(`cff-skip: ${(e as Error).message}`);
      }
    }
    return result(count > 0, [`unflattened=${count}`, ...notes]);
  },
};
