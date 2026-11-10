/**
 * 成员访问规范化：obj['prop'] → obj.prop（prop 为合法标识符时）
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const memberNormalize: Transform = {
  name: 'member-normalize',
  risk: 'safe',
  async run(ast) {
    let count = 0;
    traverse(ast, {
      MemberExpression(path) {
        const node = path.node;
        if (!node.computed) return;
        const prop = node.property;
        if (!t.isStringLiteral(prop) || !IDENT_RE.test(prop.value)) return;
        if (path.node.optional) return; // obj?.['x'] → obj?.x 也可，但保守处理
        node.property = t.identifier(prop.value);
        node.computed = false;
        count++;
      },
    });
    return result(count > 0, [`bracket→dot=${count}`]);
  },
};
