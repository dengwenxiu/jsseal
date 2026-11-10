/**
 * 局部常量传播（propagate-constants）——fold-pure-calls 的解锁器：
 * 单赋值字面量局部变量内联到引用点 + 删除声明。
 *
 *   function main(){ var v = decrypt("…"); console.log(decrypt2(v)); }
 *   → decrypt2("…") 成为全字面量调用点 → fold-pure-calls 可继续折叠。
 *
 * 安全栅栏：
 * - binding.constant（单赋值）且 init 是原始字面量（string/number/boolean/null，
 *   含一元负数）——引用点的值与 init 逐位相同
 * - 引用必须**文本位置在声明之后**（防"文本在前、执行在后"的提格引用：
 *   声明前执行的代码读到的是 undefined——内联成字面量会改变语义）
 * - 只处理函数内局部变量（模块级单引用者众，全量内联会膨胀——留给
 *   prune-dead-decls 处理无人引用的场景）
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';
import type { NodePath } from '@babel/traverse';

function isPrimitiveLiteral(n: t.Node): n is t.Expression {
  return t.isStringLiteral(n) || t.isNumericLiteral(n) || t.isBooleanLiteral(n) || t.isNullLiteral(n)
    || (t.isUnaryExpression(n) && n.operator === '-' && t.isNumericLiteral(n.argument));
}

/** Identifier 是否处于被引用位置 */
function isRefPos(node: t.Identifier, parent: t.Node | null): boolean {
  if (!parent) return true;
  if (t.isMemberExpression(parent) && !parent.computed && parent.property === node) return false;
  if (t.isObjectProperty(parent) && !parent.shorthand && parent.key === node) return false;
  if (t.isObjectMethod(parent) && !parent.computed && parent.key === node) return false;
  if ((t.isLabeledStatement(parent) || t.isBreakStatement(parent) || t.isContinueStatement(parent)) && parent.label === node) return false;
  if (t.isFunctionDeclaration(parent) && parent.id === node) return false;
  return true;
}

export const propagateConstants: Transform = {
  name: 'propagate-constants',
  risk: 'safe',
  async run(ast) {
    // 收集：单赋值字面量局部变量（函数内）→ {binding, initPath 起始偏移}
    const jobs: Array<{ binding: import('@babel/traverse').Binding; declEnd: number; init: t.Expression }> = [];
    traverse(ast, {
      VariableDeclarator(path) {
        const init = path.node.init;
        if (!path.node.id || !t.isIdentifier(path.node.id) || !init || !isPrimitiveLiteral(init)) return;
        const fnScope = path.scope.getFunctionParent();
        const programScope = path.scope.getProgramParent();
        if (!fnScope || fnScope === programScope) return; // 只做函数内局部
        const binding = fnScope.getBinding(path.node.id.name);
        if (!binding || !binding.constant) return; // 单赋值
        if (binding.path !== path) return;
        jobs.push({ binding, declEnd: path.node.end ?? 0, init: t.cloneNode(init, true) });
      },
    });
    if (jobs.length === 0) return result(false, ['no const locals']);

    let inlined = 0;
    let removedDecls = 0;
    for (const job of jobs) {
      // 全部引用点文本位置必须在声明之后
      const refs = job.binding.referencePaths;
      if (refs.length === 0) continue;
      if (refs.some((r) => (r.node.start ?? 0) < job.declEnd)) continue;
      // 引用点含声明自身 id？referencePaths 只含引用
      for (const ref of refs) {
        if (!ref.node || ref.removed) continue;
        try {
          ref.replaceWith(t.cloneNode(job.init, true));
          inlined++;
        } catch { /* skip */ }
      }
      // 删除声明（单赋值已内联；declarator 可能与兄弟共存）
      const dp = job.binding.path;
      if (!dp.removed && t.isVariableDeclarator(dp.node)) {
        try {
          dp.remove();
          removedDecls++;
        } catch { /* skip */ }
      }
    }
    if (inlined === 0) return result(false, ['no inlinable refs']);
    return result(true, [`inlined=${inlined}`, `decls=${removedDecls}`]);
  },
};
