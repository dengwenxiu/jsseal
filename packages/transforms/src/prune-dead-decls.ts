/**
 * 通用死声明清理（prune-dead-decls）——fold/inline 之后的收尾：
 * 模块顶层无人引用的函数声明与变量声明（不动点：删 A 使 B 也不再被引用）。
 *
 * prune-dead-pool 是家族专用（obfuscator.io 三件套命名）；本变换家族无关，
 * 处理 fold-pure-calls 折完全部调用点后变 dead 的解码函数与池。
 *
 * 保守栅栏（动态可达性防误删）：
 * - 代码中出现 eval / new Function → 整体放弃
 * - 计算成员访问的字符串字面量（x["name"]）视为对 name 的潜在引用
 * - 引用判定按名字（同名 shadow 的引用会保守地保住外层——宁漏删不误删）
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

/** 判定表：每条规则对应一种"标识符不在引用位置"的父节点形状 */
const NON_REFERENCE_POSITIONS: readonly ((
  parent: t.Node,
  node: t.Identifier
) => boolean)[] = [
  (parent, node) =>
    t.isMemberExpression(parent) &&
    !parent.computed &&
    parent.property === node,
  (parent, node) =>
    t.isObjectProperty(parent) && !parent.shorthand && parent.key === node,
  (parent, node) =>
    t.isObjectMethod(parent) && !parent.computed && parent.key === node,
  (parent, node) =>
    (t.isLabeledStatement(parent) ||
      t.isBreakStatement(parent) ||
      t.isContinueStatement(parent)) &&
    parent.label === node,
  (parent, node) => t.isVariableDeclarator(parent) && parent.id === node,
  (parent, node) => t.isFunctionDeclaration(parent) && parent.id === node,
  (parent, node) => t.isFunction(parent) && parent.params.includes(node),
  (parent, node) => t.isCatchClause(parent) && parent.param === node,
  (parent, node) => t.isAssignmentPattern(parent) && parent.left === node,
  (parent, node) => t.isRestElement(parent) && parent.argument === node,
];

/**
 * 引用位置判定：排除属性键/标签/声明位置（声明 id 自身不是引用——
 * 否则 `var dead` 的 id 会把自己保进 used 集合，实测一个都删不掉）
 */
const isRefPos = (node: t.Identifier, parent: t.Node | null): boolean => {
  if (!parent) {
    return true;
  }

  return !NON_REFERENCE_POSITIONS.some((isNonReference) =>
    isNonReference(parent, node)
  );
};

export const pruneDeadDecls: Transform = {
  name: "prune-dead-decls",
  risk: "safe",
  // oxlint-disable-next-line eslint/require-await -- Transform.run 契约固定返回 Promise（governor await），但本变换无异步步骤；去掉 async 会触发 typescript/promise-function-async，两条规则在此互斥
  async run(ast) {
    // eval / Function 构造器存在 → 放弃
    let hasEval = false;

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（Identifier），改成小驼峰会让该 visitor 永不触发
      Identifier: (path) => {
        if (path.node.name === "eval" && isRefPos(path.node, path.parent)) {
          hasEval = true;
        }
      },
      // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（NewExpression），改成小驼峰会让该 visitor 永不触发
      NewExpression: (path) => {
        if (t.isIdentifier(path.node.callee, { name: "Function" })) {
          hasEval = true;
        }
      },
    });

    if (hasEval) {
      return result(false, ["eval present"]);
    }

    // 全局对象动态访问（globalThis[k] / window[k]）：间接引用静态不可见——
    // 接收者几乎必是全局对象，出现即放弃（真实生效的动态引用另有锚库兜底）
    let hasGlobalObj = false;

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（Identifier），改成小驼峰会让该 visitor 永不触发
      Identifier: (path) => {
        if (
          ["globalThis", "window", "self", "global"].includes(path.node.name) &&
          isRefPos(path.node, path.parent)
        ) {
          hasGlobalObj = true;
        }
      },
    });

    if (hasGlobalObj) {
      return result(false, ["global-object access present"]);
    }

    let removedFns = 0;
    let removedVars = 0;

    for (let iter = 0; iter < 6; iter += 1) {
      // 引用名集合（全部引用位置 + 动态字符串键）
      const used = new Set<string>();

      traverse(ast, {
        // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（Identifier），改成小驼峰会让该 visitor 永不触发
        Identifier: (path) => {
          if (isRefPos(path.node, path.parent)) {
            used.add(path.node.name);
          }
        },
        // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（StringLiteral），改成小驼峰会让该 visitor 永不触发
        StringLiteral: (path) => {
          if (t.isMemberExpression(path.parent) && path.parent.computed) {
            used.add(path.node.value);
          }
        },
      });

      // 声明处自身也贡献 used（同名判定保守）——先移除声明 id 再比对：
      // 改为收集"未被引用的顶层声明"：名字不在 used 中
      const deadFns: NodePath<t.FunctionDeclaration>[] = [];
      const deadDecls: NodePath<t.VariableDeclarator>[] = [];
      let programPath: NodePath<t.Program> | undefined;

      traverse(ast, {
        // oxlint-disable-next-line sonarjs/function-name -- Babel visitor 键必须是 AST 节点类型名（Program），改成小驼峰会让该 visitor 永不触发
        Program: (path) => {
          programPath = path;

          for (const stmtPath of path.get("body")) {
            if (stmtPath.isFunctionDeclaration()) {
              const { id } = stmtPath.node;

              if (id && !used.has(id.name)) {
                deadFns.push(stmtPath);
              }
            }

            if (stmtPath.isVariableDeclaration()) {
              for (const declPath of stmtPath.get("declarations")) {
                const { id } = declPath.node;

                if (t.isIdentifier(id) && !used.has(id.name)) {
                  deadDecls.push(declPath);
                }
              }
            }
          }
        },
      });

      if (!programPath || (deadFns.length === 0 && deadDecls.length === 0)) {
        break;
      }

      for (const fp of deadFns) {
        try {
          fp.remove();
          removedFns += 1;
        } catch {
          /* skip */
        }
      }

      for (const dp of deadDecls) {
        try {
          dp.remove();
          removedVars += 1;
        } catch {
          /* skip */
        }
      }
    }

    if (removedFns === 0 && removedVars === 0) {
      return result(false, ["no dead decls"]);
    }

    return result(true, [`functions=${removedFns}`, `vars=${removedVars}`]);
  },
};
