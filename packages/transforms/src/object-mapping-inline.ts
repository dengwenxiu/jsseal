/**
 * 对象键映射还原（obfuscator.io 对象映射代理）：
 *
 *   `var m = {'k1': function (a, b) { return a + b; }, 'k2': 'const'};`
 *   m['k1'](x, y)      → x + y
 *   m['k2']            → 'const'
 *
 * 条件：映射对象为 const 局部对象字面量；函数属性为单 return 且仅用形参；
 * 实参为字面量/标识符，或每个形参在体内恰好使用一次（避免重复求值改变语义）。
 * 全部引用替换后删除声明。
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

interface MappingFn {
  params: t.Identifier[];
  body: t.Expression;
}

type PropValue =
  | { kind: "fn"; fn: MappingFn }
  | { kind: "lit"; node: t.Expression };

/** 遍历时跳过的节点键：位置/注释信息不属于 AST 结构 */
const NON_CHILD_KEYS = new Set(["loc", "leadingComments", "trailingComments"]);

/** 成员访问的静态键：m['k'] 或 m.k；动态键返回 null */
const memberKey = (m: t.MemberExpression): string | null => {
  if (m.computed) {
    return t.isStringLiteral(m.property) ? m.property.value : null;
  }

  return t.isIdentifier(m.property) ? m.property.name : null;
};

const isSimpleArg = (a: t.Node): boolean => t.isIdentifier(a) || t.isLiteral(a);

/** 动态取到的值是否是 AST 节点（即带 type 字段的对象） */
const isAstNode = (value: unknown): value is t.Node =>
  typeof value === "object" && value !== null && "type" in value;

/** 手工遍历裸 AST 节点（不进内层函数/类作用域）；visit 返回 true 表示停止下探该节点 */
const walkNodeFields = (
  node: t.Node,
  visit: (child: t.Node) => boolean
): void => {
  if (visit(node) || t.isFunction(node) || t.isClass(node)) {
    return;
  }

  for (const key of Object.keys(node)) {
    if (NON_CHILD_KEYS.has(key)) {
      continue;
    }

    // SAFETY: key 来自 Object.keys(node)，必然是节点自身的可枚举字段
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- Babel 节点是判别联合，按字符串键遍历只能经 Record<string, unknown> 退到未知值：改成逐类型显式遍历会漏掉新增节点类型（行为不再覆盖全部 AST 形态）
    const value = (node as unknown as Record<string, unknown>)[key];
    const children: readonly unknown[] = Array.isArray(value) ? value : [value];

    for (const child of children) {
      if (isAstNode(child)) {
        walkNodeFields(child, visit);
      }
    }
  }
};

/** 统计 Identifier 在表达式中的出现次数 */
const countUses = (expr: t.Expression, name: string): number => {
  let n = 0;

  walkNodeFields(expr, (node) => {
    if (t.isIdentifier(node) && node.name === name) {
      n += 1;

      return true;
    }

    return false;
  });

  return n;
};

/** 表达式体内是否出现 this/arguments（代入后会改变指向，必须跳过该映射函数） */
const usesThisOrArguments = (body: t.Expression): boolean => {
  let found = false;

  walkNodeFields(body, (node) => {
    if (
      t.isThisExpression(node) ||
      t.isIdentifier(node, { name: "arguments" })
    ) {
      found = true;

      return true;
    }

    return false;
  });

  return found;
};

/** 属性键名：字符串字面量或标识符；其它（计算键等）返回 null */
const propKey = (key: t.Node): string | null => {
  if (t.isStringLiteral(key)) {
    return key.value;
  }

  if (t.isIdentifier(key)) {
    return key.name;
  }

  return null;
};

/** 属性值为"单 return + 仅用形参 + 不含 this/arguments"的函数时，返回其形参与返回表达式 */
const asMappingFn = (value: t.Node): MappingFn | null => {
  if (!t.isFunctionExpression(value) || value.id) {
    return null;
  }

  const bodyStmts = value.body.body.filter((s) => !t.isEmptyStatement(s));
  const [firstStmt] = bodyStmts;

  if (
    bodyStmts.length !== 1 ||
    !t.isReturnStatement(firstStmt) ||
    !firstStmt.argument
  ) {
    return null;
  }

  if (!value.params.every((p) => t.isIdentifier(p))) {
    return null;
  }

  // 手工 walker，避免对裸节点 traverse
  if (usesThisOrArguments(firstStmt.argument)) {
    return null;
  }

  return { params: value.params, body: firstStmt.argument };
};

/** 解析映射对象的一个属性；形态不支持时返回 null */
const parseMappingProp = (prop: t.Node): [string, PropValue] | null => {
  if (!t.isObjectProperty(prop) || prop.computed) {
    return null;
  }

  const key = propKey(prop.key);

  if (key === null) {
    return null;
  }

  const fn = asMappingFn(prop.value);

  if (fn) {
    return [key, { kind: "fn", fn }];
  }

  const { value } = prop;

  if (
    t.isStringLiteral(value) ||
    t.isNumericLiteral(value) ||
    t.isBooleanLiteral(value)
  ) {
    return [key, { kind: "lit", node: value }];
  }

  return null;
};

/** 标识符代入（在克隆的表达式上把引用标识符替换为实参） */
const substitute = (
  expr: t.Expression,
  name: string,
  arg: t.Node
): t.Expression => {
  const stmt = t.expressionStatement(t.cloneNode(expr));
  const file = t.file(t.program([stmt]));

  traverse(file, {
    // oxlint-disable-next-line sonarjs/function-name -- 键名即 Babel traverse 的 visitor 类型名（大写驼峰），改名后不再是 visitReferencedIdentifier 的别名
    ReferencedIdentifier(ip) {
      if (ip.node.name === name) {
        ip.replaceWith(t.cloneNode(arg));
      }
    },
  });

  return stmt.expression;
};

export const inlineObjectMapping: Transform = {
  name: "inline-object-mapping",
  risk: "unsafe",
  // oxlint-disable-next-line eslint/require-await -- Transform.run 的契约是 Promise（governor 统一 await）；实现全程同步，去掉 async 不改变行为但与同类变换签名不一致
  async run(ast) {
    let replacedCalls = 0;
    let replacedValues = 0;
    let removedDecls = 0;

    // 收集映射对象声明：var m = { 全是函数(单return)或字面量 }
    const mappings = new Map<string, Map<string, PropValue>>();
    const declPaths = new Map<string, NodePath<t.VariableDeclarator>>();

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- 键名即 Babel traverse 的 visitor 类型名（大写驼峰），改名后不再是 visitVariableDeclarator 的别名
      VariableDeclarator(path) {
        const { id, init } = path.node;

        if (
          !t.isIdentifier(id) ||
          !t.isObjectExpression(init) ||
          init.properties.length === 0
        ) {
          return;
        }

        const binding = path.scope.getBinding(id.name);

        // 声明后不可重赋值
        if (!binding || binding.constantViolations.length > 0) {
          return;
        }

        const props = new Map<string, PropValue>();

        for (const prop of init.properties) {
          const parsed = parseMappingProp(prop);

          if (parsed === null) {
            return;
          }

          const [key, value] = parsed;

          props.set(key, value);
        }

        if (props.size === 0) {
          return;
        }

        mappings.set(id.name, props);
        declPaths.set(id.name, path);
      },
    });

    if (mappings.size === 0) {
      return result(false, ["no mapping objects"]);
    }

    // 替换调用点：m['k'](a, b) → 函数体代入
    const callJobs: {
      path: NodePath;
      args: t.CallExpression["arguments"];
      fn: MappingFn;
    }[] = [];

    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- 键名即 Babel traverse 的 visitor 类型名（大写驼峰），改名后不再是 visitCallExpression 的别名
      CallExpression(path) {
        const { callee } = path.node;

        if (!t.isMemberExpression(callee) || !t.isIdentifier(callee.object)) {
          return;
        }

        const props = mappings.get(callee.object.name);

        if (!props) {
          return;
        }

        const key = memberKey(callee);

        if (key === null) {
          return;
        }

        const prop = props.get(key);

        if (prop?.kind !== "fn") {
          return;
        }

        const args = path.node.arguments;

        if (args.length !== prop.fn.params.length) {
          return;
        }

        const simpleArgs = args.every(
          (a) => t.isExpression(a) && isSimpleArg(a)
        );

        // 复杂实参：仅当每个形参至多用一次才允许代入
        const paramsUsedOnce = prop.fn.params.every(
          (p) => countUses(prop.fn.body, p.name) <= 1
        );

        if (!simpleArgs && !paramsUsedOnce) {
          return;
        }

        callJobs.push({ path, args, fn: prop.fn });
      },
    });

    for (const job of callJobs) {
      const { params, body } = job.fn;
      let expr = t.cloneNode(body);

      for (let i = 0; i < params.length; i += 1) {
        expr = substitute(expr, params[i].name, t.cloneNode(job.args[i]));
      }

      try {
        job.path.replaceWith(expr);
        replacedCalls += 1;
      } catch {
        /* skip */
      }
    }

    // 替换纯值引用：m['k2'] → 字面量（未被调用的字面量属性）
    traverse(ast, {
      // oxlint-disable-next-line sonarjs/function-name -- 键名即 Babel traverse 的 visitor 类型名（大写驼峰），改名后不再是 visitMemberExpression 的别名
      MemberExpression(path) {
        const { node } = path;

        if (!t.isIdentifier(node.object)) {
          return;
        }

        const props = mappings.get(node.object.name);

        if (!props) {
          return;
        }

        const key = memberKey(node);

        if (key === null) {
          return;
        }

        const prop = props.get(key);

        if (prop?.kind !== "lit") {
          return;
        }

        // 调用位置（m['k'](...)）跳过
        const parent = path.parentPath?.node;

        if (t.isCallExpression(parent) && parent.callee === node) {
          return;
        }

        path.replaceWith(t.cloneNode(prop.node));
        replacedValues += 1;
      },
    });

    // 声明清理：无引用则删
    for (const [name, dp] of declPaths) {
      let refs = 0;

      traverse(ast, {
        // oxlint-disable-next-line sonarjs/function-name -- 键名即 Babel traverse 的 visitor 类型名（大写驼峰），改名后不再是 visitReferencedIdentifier 的别名
        ReferencedIdentifier(rp) {
          if (rp.node.name === name) {
            refs += 1;
          }
        },
      });

      // oxlint-disable-next-line typescript/strict-boolean-expressions -- NodePath.node 在 remove() 后为 null（类型声明为非空对象，TS2367 禁止与 null 比较），只能用真值判断
      if (refs === 0 && dp.node) {
        dp.remove();
        removedDecls += 1;
      }
    }

    return result(replacedCalls + replacedValues > 0, [
      `calls=${replacedCalls}`,
      `values=${replacedValues}`,
      `decls-removed=${removedDecls}`,
    ]);
  },
};
