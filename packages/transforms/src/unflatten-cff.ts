/**
 * 控制流扁平化还原（obfuscator.io switch-dispatcher 标准形）：
 *
 * ```
 * var seq = '0|3|1|2'.split('|'), i = 0;
 * while (!![]) {
 *   switch (seq[i++]) {
 *     case '0': ...; continue;
 *     case '3': ...; continue;
 *     ...
 *   }
 *   break;
 * }
 * ```
 *
 * → 按序重排 case 体，删除分发器。case 体内含裸 break/continue 时放弃（保守）。
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

/** AST 节点上不承载子节点的元数据键（子树遍历时跳过） */
const NODE_METADATA_KEYS = new Set([
  "loc",
  "leadingComments",
  "trailingComments",
]);

/** 值是否是可下钻的 AST 节点 */
const isNodeLike = (value: unknown): value is t.Node =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- AST 子属性来自动态字符串键取值，编译期无类型契约，只能运行时按 typeof 判形状
  typeof value === "object" && value !== null && "type" in value;

/** AST 节点的属性表（Babel 节点是纯数据对象，键值即子节点或标量） */
const nodeEntries = (node: t.Node): [string, unknown][] => {
  const value: unknown = node;

  // SAFETY: Babel AST 节点是纯数据对象，属性名→值即子节点/标量表，无访问器副作用
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type, typescript/no-unsafe-type-assertion -- AST 属性值域本身是"节点或标量"，编译期没有更具体的类型可写
  const record = value as Record<string, unknown>;

  return Object.entries(record);
};

const truthyLike = (test: t.Expression): boolean => {
  if (t.isBooleanLiteral(test)) {
    return test.value;
  }

  if (t.isUnaryExpression(test) && test.operator === "!") {
    const a = test.argument;

    if (
      t.isUnaryExpression(a) &&
      a.operator === "!" &&
      (t.isArrayExpression(a.argument) || t.isObjectExpression(a.argument))
    ) {
      return true;
    }
  }

  return false;
};

const containsBareJump = (node: t.Node): boolean => {
  let found = false;

  const walk = (n: t.Node): void => {
    if (found) {
      return;
    }

    if (t.isContinueStatement(n) && !n.label) {
      // 属于外层 while 的裸 continue
      found = true;

      return;
    }

    if (t.isBreakStatement(n) && !n.label) {
      // 内层 switch/break 合法——只标记"直接位于 case 体"的裸 break 由调用方处理；
      // 这里无法区分层级，保守视为复杂跳转
      found = true;

      return;
    }

    if (
      t.isForStatement(n) ||
      t.isWhileStatement(n) ||
      t.isDoWhileStatement(n) ||
      t.isSwitchStatement(n)
    ) {
      // 循环/switch 内部的 break 属于该结构，不干扰外层——跳过其子树
      return;
    }

    for (const [key, value] of nodeEntries(n)) {
      if (NODE_METADATA_KEYS.has(key)) {
        continue;
      }

      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNodeLike(child)) {
            walk(child);
          }
        }
      } else if (isNodeLike(value)) {
        walk(value);
      }
    }
  };

  walk(node);

  return found;
};

interface SeqDecl {
  declPath: NodePath<t.VariableDeclarator>;
  order: string[];
}

/** 求值结果是否字符串（`NodePath#evaluate` 的 value 是 any，只能运行时判） */
const isStringValue = (value: unknown): value is string =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- evaluate() 的 value 是 any，类型层无契约，只能运行时按 typeof 判
  typeof value === "string";

/** 在 scopeRoot 子树里找 `seq = '<顺序串>'.split('|')` 声明 */
const findSeqDeclIn = (
  scopeRoot: NodePath,
  seqName: string
): SeqDecl | null => {
  let found: SeqDecl | null = null;

  const onVariableDeclarator = (dp: NodePath<t.VariableDeclarator>): void => {
    if (found !== null) {
      return;
    }

    const { id } = dp.node;

    if (!t.isIdentifier(id) || id.name !== seqName) {
      return;
    }

    const { init } = dp.node;

    if (!init || !t.isCallExpression(init)) {
      return;
    }

    if (
      !t.isMemberExpression(init.callee) ||
      !t.isIdentifier(init.callee.property) ||
      init.callee.property.name !== "split"
    ) {
      return;
    }

    const [sepArg] = init.arguments;
    const sep = t.isStringLiteral(sepArg) ? sepArg.value : undefined;

    if (sep !== "|") {
      return;
    }

    const obj = init.callee.object;
    let orderStr: string | null = null;

    if (t.isStringLiteral(obj)) {
      orderStr = obj.value;
    } else {
      // 顺序串藏在常量成员里（对象映射 {'xJszW': '0|1|2|...'}）——求值解析
      try {
        // SAFETY: init 已由 t.isCallExpression 校验；字符串键路径 get() 实际只返回单个 NodePath，类型层是 NodePath | NodePath[]
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NodePath#get(string) 的联合返回类型无法表达"单路径"，断言是取其单路径形态的唯一写法
        const memberPath = (dp.get("init") as NodePath).get(
          "callee.object"
        ) as NodePath;

        const res = memberPath.evaluate();
        const value: unknown = res.value;

        if (res.confident && isStringValue(value)) {
          orderStr = value;
        }
      } catch {
        /* ignore */
      }
    }

    if (orderStr === null) {
      return;
    }

    found = { declPath: dp, order: orderStr.split("|") };
  };

  scopeRoot.traverse({ VariableDeclarator: onVariableDeclarator });

  return found;
};

/** 查找 seq 声明：var seq = 'a|b|c'.split('|')（或任意字符串字面量 split） */
const findSeqDecl = (
  whilePath: NodePath<t.WhileStatement>,
  seqName: string
): SeqDecl | null => {
  let wp: NodePath | null = whilePath.parentPath;

  while (wp !== null) {
    const found = findSeqDeclIn(wp, seqName);

    if (found !== null) {
      return found;
    }

    wp = wp.parentPath;
  }

  return null;
};

/** body 必须是 \{ switch, (break)? \} 或直接 switch */
const dispatcherSwitch = (node: t.WhileStatement): t.SwitchStatement | null => {
  const body: readonly t.Statement[] = t.isBlockStatement(node.body)
    ? node.body.body
    : [node.body];

  let sw: t.SwitchStatement | null = null;

  for (const stmt of body) {
    if (t.isSwitchStatement(stmt)) {
      sw = stmt;
      break;
    }
  }

  if (sw === null) {
    return null;
  }

  for (const stmt of body) {
    if (stmt !== sw && !t.isBreakStatement(stmt)) {
      return null;
    }
  }

  return sw;
};

/** discrim 形如 seq[i++] 时返回 seq 的名字 */
const seqNameOf = (sw: t.SwitchStatement): string | null => {
  const d = sw.discriminant;

  if (!t.isMemberExpression(d) || !d.computed || !t.isIdentifier(d.object)) {
    return null;
  }

  if (
    !t.isUpdateExpression(d.property) ||
    d.property.operator !== "++" ||
    !t.isIdentifier(d.property.argument)
  ) {
    return null;
  }

  return d.object.name;
};

/** case 体收集（default/非常量 case、裸跳转 → null 放弃） */
const caseBodies = (
  sw: t.SwitchStatement
): Map<string, t.Statement[]> | null => {
  const caseMap = new Map<string, t.Statement[]>();

  for (const c of sw.cases) {
    if (c.test === null || c.test === undefined || !t.isStringLiteral(c.test)) {
      // default/非常量 → 放弃
      return null;
    }

    const stmts = [...c.consequent];
    const last = stmts.at(-1);

    if (last !== undefined && t.isContinueStatement(last) && !last.label) {
      stmts.pop();
    }

    for (const s of stmts) {
      if (containsBareJump(s)) {
        return null;
      }
    }

    caseMap.set(c.test.value, stmts);
  }

  return caseMap;
};

/** 静态还原单个分发器（true = 已按序重排并替换循环） */
const tryUnflatten = (path: NodePath<t.WhileStatement>): boolean => {
  if (!truthyLike(path.node.test)) {
    return false;
  }

  const sw = dispatcherSwitch(path.node);

  if (sw === null) {
    return false;
  }

  const seqName = seqNameOf(sw);

  if (seqName === null) {
    return false;
  }

  const seq = findSeqDecl(path, seqName);

  if (seq === null) {
    return false;
  }

  const caseMap = caseBodies(sw);

  if (caseMap === null) {
    return false;
  }

  // 按序重排
  const out: t.Statement[] = [];

  for (const key of seq.order) {
    const stmts = caseMap.get(key);

    if (stmts === undefined) {
      return false;
    }

    out.push(...stmts);
  }

  const { declPath } = seq;

  path.replaceWith(t.blockStatement(out));

  // 删除 seq declarator（若所属声明只剩它则整句删除）
  try {
    declPath.remove();
  } catch {
    /* 已被移除 */
  }

  return true;
};

export const unflattenCff: Transform = {
  name: "unflatten-cff",
  risk: "unsafe",
  // oxlint-disable-next-line eslint/require-await -- Transform.run 接口约定返回 Promise，本变换无异步步骤；去掉 async 会违反接口签名
  async run(ast) {
    let count = 0;
    const notes: string[] = [];
    const targets: NodePath<t.WhileStatement>[] = [];

    const onWhileStatement = (path: NodePath<t.WhileStatement>): void => {
      if (!truthyLike(path.node.test)) {
        return;
      }

      const { body } = path.node;
      const stmts = t.isBlockStatement(body) ? body.body : [body];

      if (stmts.some((s) => t.isSwitchStatement(s))) {
        targets.push(path);
      }
    };

    traverse(ast, { WhileStatement: onWhileStatement });

    for (const target of targets) {
      // 前续替换可能已使其失效（Babel 在节点被移除时把 node 置空，类型未声明可空）
      const node: t.WhileStatement | null = target.node;

      if (node === null) {
        continue;
      }

      try {
        if (tryUnflatten(target)) {
          count += 1;
        }
      } catch (error) {
        // Babel 抛的是 Error；其他类型只做字符串化
        const message = error instanceof Error ? error.message : String(error);

        notes.push(`cff-skip: ${message}`);
      }
    }

    return result(count > 0, [`unflattened=${count}`, ...notes]);
  },
};
