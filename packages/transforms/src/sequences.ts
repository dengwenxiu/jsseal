/**
 * 序列表达式拆分（逗号表达式）：
 *  - 表达式语句级：a(), b(), c() → 三条语句
 *  - return (a(), b) → a(); return b
 *  - for 初始化序列：for(a(),b=1;;) → a(); b=1; for(;;)
 *  注意：不拆 for 的 update 序列（continue 语义差异），不拆 if 测试（保持保守）。
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

export const splitSequences: Transform = {
  name: "split-sequences",
  risk: "safe",
  // oxlint-disable-next-line eslint/require-await -- Transform 契约要求 run 返回 Promise；实现全同步，去掉 async 需 Promise.resolve 包装，反而触发 typescript/promise-function-async（两规则互斥）
  async run(ast) {
    let count = 0;

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- visitor 键必须是 babel 节点类型名，改为小写驼峰即不再被派发，变换失效
      ExpressionStatement(path) {
        const expr = path.node.expression;

        if (!t.isSequenceExpression(expr)) {
          return;
        }

        path.replaceWithMultiple(
          expr.expressions.map((e) => t.expressionStatement(e))
        );
        count += 1;
      },
      // oxlint-disable-next-line sonarjs/function-name -- visitor 键必须是 babel 节点类型名，改为小写驼峰即不再被派发，变换失效
      ReturnStatement(path) {
        const arg = path.node.argument;

        if (!arg || !t.isSequenceExpression(arg)) {
          return;
        }

        const exprs = arg.expressions;
        const lead = exprs.slice(0, -1).map((e) => t.expressionStatement(e));

        path.replaceWithMultiple([...lead, t.returnStatement(exprs.at(-1))]);
        count += 1;
      },
      // oxlint-disable-next-line sonarjs/function-name -- visitor 键必须是 babel 节点类型名，改为小写驼峰即不再被派发，变换失效
      ForStatement(path) {
        const { init } = path.node;

        if (!init || !t.isSequenceExpression(init)) {
          return;
        }

        const exprs = init.expressions;
        const lead = exprs.slice(0, -1).map((e) => t.expressionStatement(e));

        path.node.init = exprs.at(-1);
        // 逐条 insertBefore（保持顺序，兼容任意父级位置）
        let cursor: NodePath = path;

        for (const st of lead) {
          const inserted = cursor.insertBefore(st);

          cursor = Array.isArray(inserted) ? inserted[0] : inserted;
        }

        count += 1;
      },
    });

    return result(count > 0, [`sequences-split=${count}`]);
  },
};
