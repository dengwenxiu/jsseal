/**
 * 代理函数内联：形如 `f(a,b)` 体内只有一条 `return g(a,b)` 的包装函数 →
 * 调用点直接调 g。
 * 条件：单 return、实参严格等于形参（原序）、体内无 this/arguments、非递归。
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

interface ProxyCandidate {
  declPath: NodePath<t.FunctionDeclaration>;
  target: string;
  name: string;
}

/** 转发调用形状校验：形参全是标识符，实参数量与位置逐位等于形参（改序/改值都会改变求值语义） */
const isPositionalForwarding = (
  params: readonly t.Node[],
  args: readonly t.Node[]
): boolean => {
  if (args.length !== params.length) {
    return false;
  }

  for (let i = 0; i < params.length; i += 1) {
    const param = params[i];
    const arg = args[i];

    if (
      !t.isIdentifier(param) ||
      !t.isIdentifier(arg) ||
      arg.name !== param.name
    ) {
      return false;
    }
  }

  return true;
};

/** 识别"纯转发"代理函数；不符合条件返回 undefined（本函数不改动 AST） */
const readProxyCandidate = (
  path: NodePath<t.FunctionDeclaration>
): ProxyCandidate | undefined => {
  const name = path.node.id?.name;

  if (name === undefined || name === "") {
    return undefined;
  }

  const { body } = path.node.body;

  if (body.length !== 1) {
    return undefined;
  }

  const [st] = body;

  if (
    !t.isReturnStatement(st) ||
    !st.argument ||
    !t.isCallExpression(st.argument)
  ) {
    return undefined;
  }

  const call = st.argument;

  if (!t.isIdentifier(call.callee)) {
    return undefined;
  }

  // 递归（自调用）不能内联成自己
  if (call.callee.name === name) {
    return undefined;
  }

  if (!isPositionalForwarding(path.node.params, call.arguments)) {
    return undefined;
  }

  let usesThis = false;

  path.traverse({
    // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（ThisExpression），改成小驼峰会让该 visitor 永不触发
    ThisExpression: () => {
      usesThis = true;
    },
  });

  if (usesThis) {
    return undefined;
  }

  return { declPath: path, target: call.callee.name, name };
};

/** 把候选代理的调用点换成目标函数；返回改掉的调用点数（无剩余引用时删掉代理声明） */
const inlineCandidate = (cand: ProxyCandidate): number => {
  const binding = cand.declPath.scope.getBinding(cand.name);

  if (!binding) {
    return 0;
  }

  let n = 0;
  // 快照：替换会改动 binding.referencePaths，直接迭代原数组会漏掉/跳过引用
  const refsToInline = [...binding.referencePaths];

  for (const ref of refsToInline) {
    const cp = ref.parentPath;

    if (!cp) {
      continue;
    }

    if (
      (cp.isCallExpression() || cp.isNewExpression()) &&
      cp.node.callee === ref.node
    ) {
      // ref 就是 callee 槽位上的同一节点（上面已比对身份），就地替换等价于
      // cp.get("callee").replaceWith(...)，但不必对 Call/New 联合类型取 callee 路径
      ref.replaceWith(t.identifier(cand.target));
      n += 1;
    }
  }

  if (n === 0) {
    return 0;
  }

  // 无剩余引用则删除代理声明（binding.referencePaths 替换后可能过期，重新计数）
  let remaining = 0;
  const statementPath = cand.declPath.getStatementParent();

  if (statementPath) {
    traverse(statementPath.scope.getProgramParent().path.node, {
      // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（ReferencedIdentifier），改成小驼峰会让该 visitor 永不触发
      ReferencedIdentifier: (rp) => {
        if (rp.node.name === cand.name) {
          remaining += 1;
        }
      },
    });
  }

  if (remaining === 0 && !cand.declPath.removed) {
    cand.declPath.remove();
  }

  return n;
};

export const inlineProxyFunctions: Transform = {
  name: "inline-proxy-functions",
  risk: "safe",
  // oxlint-disable-next-line eslint/require-await -- Transform.run 契约固定返回 Promise（governor await），但本变换无异步步骤；去掉 async 会触发 typescript/promise-function-async，两条规则在此互斥
  async run(ast) {
    let inlined = 0;

    const candidates: ProxyCandidate[] = [];

    // 先收齐候选再改 AST：在遍历过程中改写/删除节点会让遍历器漏访或重复访问
    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（FunctionDeclaration），改成小驼峰会让该 visitor 永不触发
      FunctionDeclaration: (path) => {
        const candidate = readProxyCandidate(path);

        if (candidate) {
          candidates.push(candidate);
        }
      },
    });

    for (const cand of candidates) {
      inlined += inlineCandidate(cand);
    }

    return result(inlined > 0, [`proxy-calls-inlined=${inlined}`]);
  },
};
