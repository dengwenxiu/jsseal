/**
 * 标识符还原命名：_0x4a3b → v1, v2, ...（全局唯一，scope.rename 处理碰撞）
 * 返回 renamePairs，governor 同步 FunctionRegistry pins 的键名。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';

const HEX_NAME = /^_?0x[0-9a-fA-F]{3,}$/;

export const demangleNames: Transform = {
  name: 'demangle-names',
  risk: 'unsafe', // eval 字符串引用名时会被锚库拦截
  async run(ast) {
    const renamePairs: Array<{ from: string; to: string }> = [];
    let counter = 0;

    // 快照所有 (scope, name)，避免遍历中修改作用域
    const jobs: Array<{ scope: import('@babel/traverse').Scope; name: string }> = [];
    const seenScopes = new Set<unknown>();
    traverse(ast, {
      Scopable(path) {
        const scope = path.scope;
        if (seenScopes.has(scope)) return;
        seenScopes.add(scope);
        for (const name of Object.keys(scope.bindings)) {
          if (HEX_NAME.test(name)) jobs.push({ scope, name });
        }
      },
    });

    for (const { scope, name } of jobs) {
      const binding = scope.getBinding(name);
      if (!binding || !binding.path.node) continue;
      counter++;
      const newName = `v_${counter}`;
      try {
        scope.rename(name, newName);
        renamePairs.push({ from: name, to: newName });
      } catch {
        /* 放弃该名字 */
      }
    }
    return result(renamePairs.length > 0, [`renamed=${renamePairs.length}`], renamePairs);
  },
};
