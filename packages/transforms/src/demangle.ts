/**
 * 标识符还原命名：_0x4a3b → v1, v2, ...（全局唯一，scope.rename 处理碰撞）
 * 返回 renamePairs，governor 同步 FunctionRegistry pins 的键名。
 */

import type { Scope } from "@babel/traverse";
import type * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

const HEX_NAME = /^_?0x[0-9a-fA-F]{3,}$/u;

export const demangleNames: Transform = {
  name: "demangle-names",
  // eval 字符串引用名时会被锚库拦截
  risk: "unsafe",
  // oxlint-disable-next-line eslint/require-await -- Transform 契约要求 run 返回 Promise；实现全同步，去掉 async 需 Promise.resolve 包装，反而触发 typescript/promise-function-async（两规则互斥）
  async run(ast) {
    const renamePairs: { from: string; to: string }[] = [];
    let counter = 0;

    // 快照所有 (scope, name)，避免遍历中修改作用域
    const jobs: { scope: Scope; name: string }[] = [];
    const seenScopes = new Set<unknown>();

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- visitor 键必须是 babel 节点类型名，改为小写驼峰即不再被派发，变换失效
      Scopable(path) {
        const { scope } = path;

        if (seenScopes.has(scope)) {
          return;
        }

        seenScopes.add(scope);

        for (const name of Object.keys(scope.bindings)) {
          if (HEX_NAME.test(name)) {
            jobs.push({ scope, name });
          }
        }
      },
    });

    for (const { scope, name } of jobs) {
      const binding = scope.getBinding(name);
      // 运行时（remove 之后）node 可为 null，类型上是 t.Node——按可空处理再判空
      const bindingNode: t.Node | null = binding?.path.node ?? null;

      if (!binding || !bindingNode) {
        continue;
      }

      counter += 1;
      const newName = `v_${counter}`;

      try {
        scope.rename(name, newName);
        renamePairs.push({ from: name, to: newName });
      } catch {
        /* 放弃该名字 */
      }
    }

    return result(
      renamePairs.length > 0,
      [`renamed=${renamePairs.length}`],
      renamePairs
    );
  },
};
