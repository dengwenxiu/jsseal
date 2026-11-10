/**
 * 死代码删除：
 *  1. if (常量) → 保留对应分支（死代码注入产物）
 *  2. return/throw/break/continue 之后的不可达语句删除
 *
 * 种子屏障说明：不可达代码在本封闭模型下从未执行（锚库全样本验证），
 * 删除不改变磁带消费序；可达但结果未用的种子调用本变换不触碰（保守）。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';

function isTerminal(stmt: t.Statement): boolean {
  return t.isReturnStatement(stmt) || t.isThrowStatement(stmt) || t.isBreakStatement(stmt) || t.isContinueStatement(stmt);
}

export const deadCode: Transform = {
  name: 'dead-code',
  risk: 'safe',
  async run(ast) {
    let ifFolded = 0;
    let unreachable = 0;
    traverse(ast, {
      IfStatement: {
        exit(path) {
          const testRes = path.get('test').evaluate();
          if (!testRes.confident || typeof testRes.value !== 'boolean') return;
          const keep = testRes.value ? path.node.consequent : path.node.alternate;
          if (!keep) {
            path.remove();
          } else if (t.isBlockStatement(keep)) {
            path.replaceWithMultiple(keep.body);
          } else {
            path.replaceWith(keep);
          }
          ifFolded++;
        },
      },
      BlockStatement(path) {
        const body = path.node.body;
        for (let i = 0; i < body.length; i++) {
          if (!isTerminal(body[i])) continue;
          // 允许 terminal 后的注释性空语句
          let j = i + 1;
          while (j < body.length) {
            if (t.isEmptyStatement(body[j])) {
              j++;
              continue;
            }
            break;
          }
          if (j < body.length) {
            path.node.body = body.slice(0, j);
            unreachable += body.length - j;
          }
          break;
        }
      },
      EmptyStatement(path) {
        path.remove();
      },
    });
    return result(ifFolded > 0 || unreachable > 0, [`if-folded=${ifFolded}`, `unreachable-removed=${unreachable}`]);
  },
};
