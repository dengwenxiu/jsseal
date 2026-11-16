/**
 * 反篡改机制剥离（self-defending / debug protection）：
 *  封闭运行时里它们已被中和（toString 钉死 + debugger no-op），本变换只做可读性剥离，
 *  行为等价性由锚库把关。
 *
 *  1. debugProtection：包含 'debugger'（DebuggerStatement 或 Function('debugger')）的语句
 *     及其定义名的调用语句 → 删除
 *  2. self-defending：toString 自检（含换行符检测）+ while(true) 惩罚循环 → 删除
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

interface SubtreeHit {
  hasDebugger: boolean;
  hasFormatCheck: boolean;
  hasPunishLoop: boolean;
  definedNames: Set<string>;
}

/* 自检特征正则：命中结果直接决定语句是否被删除，改写字面量本体（`u` 标志会改变
 * 转义与字符类语义）即改变判定——属行为恒等红线内的禁改项 */
/* oxlint-disable eslint/require-unicode-regexp -- 见上：正则本体是自检签名的判定依据 */
const FORMAT_TEXT_RE = /\\n|\n|\r|\t|\s{2,}/;
const FORMAT_REGEX_RE = /\\n|\s/;

/* oxlint-enable eslint/require-unicode-regexp */

const isFormatProbeMethod = (name: string): boolean =>
  name === "test" || name === "includes" || name === "indexOf";

/** 换行符检测：RegExp 字面量 pattern 里出现 `\n` 转义或真实换行 */
const isNewlineRegex = (node: t.Node | null | undefined): boolean =>
  t.isRegExpLiteral(node) && node.pattern.includes("\\n");

/** 格式检测实参：test/includes/indexOf 与换行/空白字符串组合 */
const isFormatTextArg = (arg: t.Node): boolean =>
  t.isStringLiteral(arg) && FORMAT_TEXT_RE.test(arg.value);

/** 格式检测调用：test/includes/indexOf(换行/空白串) 或 test(RegExp) */
const isFormatProbeCall = (node: t.CallExpression): boolean => {
  if (
    !t.isMemberExpression(node.callee) ||
    !t.isIdentifier(node.callee.property)
  ) {
    return false;
  }

  if (!isFormatProbeMethod(node.callee.property.name)) {
    return false;
  }

  if (node.arguments.some((arg) => isFormatTextArg(arg))) {
    return true;
  }

  const { object } = node.callee;

  return t.isRegExpLiteral(object) && FORMAT_REGEX_RE.test(object.pattern);
};

const scanSubtree = (root: t.Node): SubtreeHit => {
  const hit: SubtreeHit = {
    hasDebugger: false,
    hasFormatCheck: false,
    hasPunishLoop: false,
    definedNames: new Set(),
  };

  t.traverseFast(root, (node) => {
    if (
      t.isDebuggerStatement(node) ||
      (t.isStringLiteral(node) && node.value === "debugger")
    ) {
      hit.hasDebugger = true;
    }

    if (t.isCallExpression(node) && isFormatProbeCall(node)) {
      hit.hasFormatCheck = true;
    }

    if (isNewlineRegex(node)) {
      hit.hasFormatCheck = true;
    }

    if (
      t.isWhileStatement(node) &&
      t.isBooleanLiteral(node.test) &&
      node.test.value
    ) {
      hit.hasPunishLoop = true;
    }

    if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
      hit.definedNames.add(node.id.name);
    }

    if (t.isFunctionDeclaration(node) && node.id) {
      hit.definedNames.add(node.id.name);
    }
  });

  return hit;
};

/** self-defending 判定需含 toString 使用（减少误杀） */
const usesToString = (node: t.Node): boolean => {
  let found = false;

  t.traverseFast(node, (child) => {
    if (
      t.isMemberExpression(child) &&
      t.isIdentifier(child.property) &&
      child.property.name === "toString"
    ) {
      found = true;
    }
  });

  return found;
};

export const stripAntitamper: Transform = {
  name: "strip-antitamper",
  risk: "unsafe",
  // Transform 接口要求返回 Promise，而本变换全是同步 AST 操作
  // oxlint-disable-next-line eslint/require-await -- Transform 接口要求始终返回 Promise；去掉 async 就得包一层 Promise.resolve(...)，与契约背离更远
  async run(ast) {
    let removed = 0;
    const notes: string[] = [];

    // 收集需要删除的语句路径 + 定义名集合
    const stmtPaths: NodePath<t.Statement>[] = [];
    const definedNames = new Set<string>();

    const collectStatement = (path: NodePath<t.Statement>): void => {
      // 只处理"语句级"节点：直接父级也是语句/Program/块
      const parent = path.parentPath;

      if (
        !parent.isProgram() &&
        !parent.isStatement() &&
        !parent.isBlockStatement()
      ) {
        return;
      }

      const hit = scanSubtree(path.node);
      const isDebug = hit.hasDebugger;
      const isSelfDefending = hit.hasFormatCheck && hit.hasPunishLoop;

      if (!isDebug && !isSelfDefending) {
        return;
      }

      if (isSelfDefending && !usesToString(path.node)) {
        return;
      }

      // 避免嵌套重复收集：跳过子语句已命中父语句的情况——通过扫描范围去重
      stmtPaths.push(path);

      for (const name of hit.definedNames) {
        definedNames.add(name);
      }
    };

    traverse(ast, { Statement: collectStatement });

    // 去重：被更大范围覆盖的语句跳过（按 start 范围）
    const ranges = stmtPaths.map((p) => ({
      p,
      start: p.node.start ?? -1,
      end: p.node.end ?? -1,
    }));

    // oxlint-disable-next-line unicorn/no-array-sort -- tsconfig lib 为 ES2022（无 Array#toSorted），且对象是 map 新建数组，原地排序无外部可见副作用
    ranges.sort((a, b) => a.start - b.start);

    const keep: typeof ranges = [];

    for (const r of ranges) {
      const covered = keep.some((k) => r.start >= k.start && r.end <= k.end);

      if (!covered) {
        keep.push(r);
      }
    }

    for (const { p } of keep) {
      try {
        p.remove();
        removed += 1;
      } catch {
        /* skip */
      }
    }

    // 删除被剥离定义的所有调用语句（ExpressionStatement 引用定义名）
    if (definedNames.size > 0 && removed > 0) {
      let callRemoved = 0;

      const removeCallStatement = (
        path: NodePath<t.ExpressionStatement>
      ): void => {
        let refs = false;

        const trackIdentifierRef = (ip: NodePath<t.Identifier>): void => {
          if (definedNames.has(ip.node.name)) {
            refs = true;
          }
        };

        path.traverse({ Identifier: trackIdentifierRef });

        if (refs) {
          path.remove();
          callRemoved += 1;
        }
      };

      traverse(ast, { ExpressionStatement: removeCallStatement });

      if (callRemoved > 0) {
        notes.push(`call-sites-removed=${callRemoved}`);
      }
    }

    return result(removed > 0, [`statements-removed=${removed}`, ...notes]);
  },
};
