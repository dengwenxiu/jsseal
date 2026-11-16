/**
 * 局部常量传播（propagate-constants）——fold-pure-calls 的解锁器：
 * 单赋值字面量局部变量内联到引用点 + 删除声明。
 *
 *   function main() 内 `var v = decrypt("…")` 只被 `decrypt2(v)` 引用
 *   → decrypt2("…") 成为全字面量调用点 → fold-pure-calls 可继续折叠。
 *
 * 安全栅栏：
 * - binding.constant（单赋值）且 init 是原始字面量（string/number/boolean/null，
 *   含一元负数）——引用点的值与 init 逐位相同
 * - 引用必须**文本位置在声明之后**（防"文本在前、执行在后"的提格引用：
 *   声明前执行的代码读到的是 undefined——内联成字面量会改变语义）
 * - 只处理函数内局部变量（模块级单引用者众，全量内联会膨胀——留给
 *   prune-dead-decls 处理无人引用的场景）
 */

import type { Binding, NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

interface ConstJob {
  binding: Binding;
  declEnd: number;
  init: t.Expression;
}

interface InlineCounts {
  inlined: number;
  removedDecls: number;
}

/** 原始字面量（含一元负数）：引用点的值与 init 逐位相同 */
const isPrimitiveLiteral = (node: t.Node): node is t.Expression => {
  if (
    t.isStringLiteral(node) ||
    t.isNumericLiteral(node) ||
    t.isBooleanLiteral(node)
  ) {
    return true;
  }

  if (t.isNullLiteral(node)) {
    return true;
  }

  return (
    t.isUnaryExpression(node) &&
    node.operator === "-" &&
    t.isNumericLiteral(node.argument)
  );
};

/** 识别单赋值字面量局部变量；不满足条件返回 undefined（本函数不改动 AST） */
const readConstJob = (
  path: NodePath<t.VariableDeclarator>
): ConstJob | undefined => {
  const { init } = path.node;

  if (!t.isIdentifier(path.node.id) || !init || !isPrimitiveLiteral(init)) {
    return undefined;
  }

  // 只做函数内局部
  const fnScope = path.scope.getFunctionParent();
  const programScope = path.scope.getProgramParent();

  if (!fnScope || fnScope === programScope) {
    return undefined;
  }

  // 单赋值
  const binding = fnScope.getBinding(path.node.id.name);

  if (!binding || !binding.constant) {
    return undefined;
  }

  if (binding.path !== path) {
    return undefined;
  }

  return {
    binding,
    declEnd: path.node.end ?? 0,
    init: t.cloneNode(init, true),
  };
};

/** 单个作业：引用点全部在声明之后才替换，随后删除声明 */
const inlineJob = (job: ConstJob): InlineCounts => {
  const refs = job.binding.referencePaths;

  // 全部引用点文本位置必须在声明之后（声明前执行的代码读到的是 undefined）
  if (
    refs.length === 0 ||
    refs.some((ref) => (ref.node.start ?? 0) < job.declEnd)
  ) {
    return { inlined: 0, removedDecls: 0 };
  }

  let inlined = 0;

  // referencePaths 只含引用位置，不含声明 id 自身
  for (const ref of refs) {
    if (ref.removed) {
      continue;
    }

    try {
      ref.replaceWith(t.cloneNode(job.init, true));
      inlined += 1;
    } catch {
      /* skip */
    }
  }

  // 删除声明（单赋值已内联；declarator 可能与兄弟共存）
  const dp = job.binding.path;

  if (!dp.removed && t.isVariableDeclarator(dp.node)) {
    try {
      dp.remove();

      return { inlined, removedDecls: 1 };
    } catch {
      return { inlined, removedDecls: 0 };
    }
  }

  return { inlined, removedDecls: 0 };
};

export const propagateConstants: Transform = {
  name: "propagate-constants",
  risk: "safe",
  // oxlint-disable-next-line eslint/require-await -- Transform.run 契约固定返回 Promise（governor await），但本变换无异步步骤；去掉 async 会触发 typescript/promise-function-async，两条规则在此互斥
  async run(ast) {
    // 收集：单赋值字面量局部变量（函数内）→ {binding, declEnd, init}
    const jobs: ConstJob[] = [];

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（VariableDeclarator），改成小驼峰会让该 visitor 永不触发
      VariableDeclarator: (path) => {
        const job = readConstJob(path);

        if (job) {
          jobs.push(job);
        }
      },
    });

    if (jobs.length === 0) {
      return result(false, ["no const locals"]);
    }

    let inlined = 0;
    let removedDecls = 0;

    for (const job of jobs) {
      const counts = inlineJob(job);

      inlined += counts.inlined;
      removedDecls += counts.removedDecls;
    }

    if (inlined === 0) {
      return result(false, ["no inlinable refs"]);
    }

    return result(true, [`inlined=${inlined}`, `decls=${removedDecls}`]);
  },
};
