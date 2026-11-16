/**
 * 成员访问规范化：obj['prop'] → obj.prop（prop 为合法标识符时）
 */

import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export const memberNormalize: Transform = {
  name: "member-normalize",
  risk: "safe",
  // oxlint-disable-next-line eslint/require-await -- Transform 契约要求 run 返回 Promise；实现全同步，去掉 async 需 Promise.resolve 包装，反而触发 typescript/promise-function-async（两规则互斥）
  async run(ast) {
    let count = 0;

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- visitor 键必须是 babel 节点类型名，改为小写驼峰即不再被派发，变换失效
      MemberExpression(path) {
        const { node } = path;

        if (!node.computed) {
          return;
        }

        const prop = node.property;

        if (!t.isStringLiteral(prop) || !IDENT_RE.test(prop.value)) {
          return;
        }

        // obj?.['x'] → obj?.x 也可，但保守处理
        if (node.optional === true) {
          return;
        }

        node.property = t.identifier(prop.value);
        node.computed = false;
        count += 1;
      },
    });

    return result(count > 0, [`bracket→dot=${count}`]);
  },
};
