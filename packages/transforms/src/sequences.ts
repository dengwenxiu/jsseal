/**
 * 序列表达式拆分（逗号表达式）：
 *  - 表达式语句级：a(), b(), c() → 三条语句
 *  - return (a(), b) → a(); return b
 *  - for 初始化序列：for(a(),b=1;;) → a(); b=1; for(;;)
 *  注意：不拆 for 的 update 序列（continue 语义差异），不拆 if 测试（保持保守）。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';

export const splitSequences: Transform = {
  name: 'split-sequences',
  risk: 'safe',
  async run(ast) {
    let count = 0;
    traverse(ast, {
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!t.isSequenceExpression(expr)) return;
        path.replaceWithMultiple(expr.expressions.map((e) => t.expressionStatement(e)));
        count++;
      },
      ReturnStatement(path) {
        const arg = path.node.argument;
        if (!arg || !t.isSequenceExpression(arg)) return;
        const exprs = arg.expressions;
        const lead = exprs.slice(0, -1).map((e) => t.expressionStatement(e));
        path.replaceWithMultiple([...lead, t.returnStatement(exprs[exprs.length - 1])]);
        count++;
      },
      ForStatement(path) {
        const init = path.node.init;
        if (!init || !t.isSequenceExpression(init)) return;
        const exprs = init.expressions;
        const lead = exprs.slice(0, -1).map((e) => t.expressionStatement(e));
        path.node.init = exprs[exprs.length - 1];
        // 逐条 insertBefore（保持顺序，兼容任意父级位置）
        let cursor: import('@babel/traverse').NodePath = path;
        for (const st of lead) {
          const inserted = cursor.insertBefore(st);
          cursor = Array.isArray(inserted) ? inserted[0] : inserted;
        }
        count++;
      },
    });
    return result(count > 0, [`sequences-split=${count}`]);
  },
};
