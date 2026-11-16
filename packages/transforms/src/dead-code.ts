/**
 * 死代码删除：
 *  1. if (常量) → 保留对应分支（死代码注入产物）
 *  2. return/throw/break/continue 之后的不可达语句删除
 *
 * 种子屏障说明：不可达代码在本封闭模型下从未执行（锚库全样本验证），
 * 删除不改变磁带消费序；可达但结果未用的种子调用本变换不触碰（保守）。
 */

import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

const isTerminal = (stmt: t.Statement): boolean =>
  t.isReturnStatement(stmt) ||
  t.isThrowStatement(stmt) ||
  t.isBreakStatement(stmt) ||
  t.isContinueStatement(stmt);

/** evaluate 的 value 是 any：只有恰为布尔字面量时才有判定权（数字/字符串测试保守不动） */
const isBooleanValue = (value: unknown): value is boolean =>
  value === true || value === false;

export const deadCode: Transform = {
  name: "dead-code",
  risk: "safe",
  // oxlint-disable-next-line eslint/require-await -- Transform 契约要求 run 返回 Promise；实现全同步，去掉 async 需 Promise.resolve 包装，反而触发 typescript/promise-function-async（两规则互斥）
  async run(ast) {
    let ifFolded = 0;
    let unreachable = 0;

    traverse(ast, {
      IfStatement: {
        exit(path) {
          const testRes = path.get("test").evaluate();

          if (!testRes.confident || !isBooleanValue(testRes.value)) {
            return;
          }

          const keep = testRes.value
            ? path.node.consequent
            : path.node.alternate;

          if (!keep) {
            path.remove();
          } else if (t.isBlockStatement(keep)) {
            path.replaceWithMultiple(keep.body);
          } else {
            path.replaceWith(keep);
          }

          ifFolded += 1;
        },
      },
      // oxlint-disable-next-line sonarjs/function-name -- visitor 键必须是 babel 节点类型名，改为小写驼峰即不再被派发，变换失效
      BlockStatement(path) {
        const { body } = path.node;
        const terminalIndex = body.findIndex((stmt) => isTerminal(stmt));

        if (terminalIndex === -1) {
          return;
        }

        // 允许 terminal 后的注释性空语句
        let keep = terminalIndex + 1;

        while (keep < body.length && t.isEmptyStatement(body[keep])) {
          keep += 1;
        }

        if (keep < body.length) {
          path.node.body = body.slice(0, keep);
          unreachable += body.length - keep;
        }
      },
      // oxlint-disable-next-line sonarjs/function-name -- visitor 键必须是 babel 节点类型名，改为小写驼峰即不再被派发，变换失效
      EmptyStatement(path) {
        path.remove();
      },
    });

    return result(ifFolded > 0 || unreachable > 0, [
      `if-folded=${ifFolded}`,
      `unreachable-removed=${unreachable}`,
    ]);
  },
};
