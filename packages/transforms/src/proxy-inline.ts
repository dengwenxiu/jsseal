/**
 * 代理函数内联：f(a,b){ return g(a,b) } → 调用点直接调 g
 * 条件：单 return、实参严格等于形参（原序）、体内无 this/arguments、非递归。
 */

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';

export const inlineProxyFunctions: Transform = {
  name: 'inline-proxy-functions',
  risk: 'safe',
  async run(ast) {
    let inlined = 0;
    const candidates: Array<{
      declPath: import('@babel/traverse').NodePath<t.FunctionDeclaration>;
      target: string;
      name: string;
    }> = [];

    traverse(ast, {
      FunctionDeclaration(path) {
        const name = path.node.id?.name;
        if (!name) return;
        const body = path.node.body.body;
        if (body.length !== 1) return;
        const st = body[0];
        if (!t.isReturnStatement(st) || !st.argument || !t.isCallExpression(st.argument)) return;
        const call = st.argument;
        if (!t.isIdentifier(call.callee)) return;
        if (call.callee.name === name) return; // 递归
        const params = path.node.params;
        if (!params.every((p) => t.isIdentifier(p))) return;
        const args = call.arguments;
        if (args.length !== params.length) return;
        for (let i = 0; i < params.length; i++) {
          const a = args[i];
          if (!t.isIdentifier(a) || a.name !== (params[i] as t.Identifier).name) return;
        }
        let usesThis = false;
        path.traverse({
          ThisExpression() {
            usesThis = true;
          },
        });
        if (usesThis) return;
        candidates.push({ declPath: path, target: call.callee.name, name });
      },
    });

    for (const cand of candidates) {
      const binding = cand.declPath.scope.getBinding(cand.name);
      if (!binding) continue;
      let n = 0;
      for (const ref of [...binding.referencePaths]) {
        const cp = ref.parentPath;
        if (!cp) continue;
        if ((cp.isCallExpression() || cp.isNewExpression()) && cp.node.callee === ref.node) {
          (cp.get('callee') as import('@babel/traverse').NodePath).replaceWith(t.identifier(cand.target));
          n++;
        }
      }
      if (n > 0) {
        inlined += n;
        // 无剩余引用则删除代理声明（binding.referencePaths 替换后可能过期，重新计数）
        let remaining = 0;
        traverse(cand.declPath.getStatementParent()?.scope.getProgramParent().path.node as never, {
          ReferencedIdentifier(rp) {
            if (rp.node.name === cand.name) remaining++;
          },
        });
        if (remaining === 0 && cand.declPath.node) {
          cand.declPath.remove();
        }
      }
    }
    return result(inlined > 0, [`proxy-calls-inlined=${inlined}`]);
  },
};
