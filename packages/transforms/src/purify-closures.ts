/**
 * 局部函数纯化（POSITIONING §5.1：纯函数封闭是文件级的，局部函数可能因
 * 闭包捕获而不纯——把依赖显式化，纯化越多可优化的面越大）。
 *
 * 两条策略：
 * - **提升（hoist）**：捕获变量是单赋值（binding.constant）且初始化
 *   "位置无关纯"（字面量数组/对象/模块级引用的四则组合）→ 把声明提升到
 *   模块顶层，函数也一并提升——依赖只剩模块级绑定 + 参数 = **top-pure**。
 *   这正是"通过提升变量作用域消除不纯"。
 * - **参数化（param）**：捕获变量会被重赋值（值随时间变化）→ 作为前导
 *   参数显式化：`F(a,b)` → `F(v,a,b)`（调用点传当前值——与闭包按引用
 *   在调用时刻读值语义一致）。
 *
 * 安全栅栏（全部满足才动，governor 锚库再兜底）：
 * - 捕获变量在 F 内只读（无赋值/自增/解构目标）
 * - F 的名字引用全部是直接调用（不逃逸：无 return F / 回调 / 属性引用）
 * - F 体内不引用 `arguments`（加前导参数会改变 arguments.length）与 `this`
 *   （提升改变 this 归属）
 * - 参数化时每个调用点对捕获名解析到同一绑定（调用点局部 shadow 视为
 *   不同绑定 → 弃，防"闭包看外层、实参传 shadow"的错位）
 * - 递归自调用同样改写：F 体内自调用传的是（新）参数名——值经参数流过，
 *   语义一致
 */

import type { Binding, NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";

import { result } from "./types";
import type { Transform } from "./types";

/** 一次调用最多处理的函数数（更多靠 governor 轮次） */
const MAX_PURIFICATION_ROUNDS = 8;

/** AST 节点上不承载子节点的元数据键（子树遍历时跳过） */
const NODE_METADATA_KEYS = new Set([
  "loc",
  "leadingComments",
  "trailingComments",
  "innerComments",
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

/** Identifier 节点是否处于"被引用"位置（排除非计算属性键/标签等非引用位置） */
const isRefPosition = (node: t.Identifier, parent: t.Node | null): boolean => {
  if (!parent) {
    return true;
  }

  if (
    t.isMemberExpression(parent) &&
    !parent.computed &&
    parent.property === node
  ) {
    return false;
  }

  if (t.isObjectProperty(parent) && !parent.shorthand && parent.key === node) {
    return false;
  }

  if (t.isObjectMethod(parent) && parent.key === node && !parent.computed) {
    return false;
  }

  if (
    (t.isLabeledStatement(parent) ||
      t.isBreakStatement(parent) ||
      t.isContinueStatement(parent)) &&
    parent.label === node
  ) {
    return false;
  }

  return true;
};

/** 通用子树遍历（key 值为 AST 节点/数组即下钻） */
const walk = (
  node: t.Node,
  visit: (n: t.Node, parent: t.Node | null) => void,
  parent: t.Node | null = null
): void => {
  visit(node, parent);

  for (const [key, value] of nodeEntries(node)) {
    if (NODE_METADATA_KEYS.has(key)) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const child of value) {
        if (isNodeLike(child)) {
          walk(child, visit, node);
        }
      }
    } else if (isNodeLike(value)) {
      walk(value, visit, node);
    }
  }
};

/** F 体内被赋值（写）的标识符集合 */
const mutatedNames = (fn: t.FunctionDeclaration): Set<string> => {
  const names = new Set<string>();

  const checkTarget = (pat: t.Node | null | undefined): void => {
    if (pat === null || pat === undefined) {
      return;
    }

    if (t.isIdentifier(pat)) {
      names.add(pat.name);
    } else if (t.isRestElement(pat)) {
      checkTarget(pat.argument);
    } else if (t.isAssignmentPattern(pat)) {
      checkTarget(pat.left);
    } else if (t.isArrayPattern(pat)) {
      for (const element of pat.elements) {
        checkTarget(element);
      }
    } else if (t.isObjectPattern(pat)) {
      for (const property of pat.properties) {
        checkTarget(t.isRestElement(property) ? property : property.value);
      }
    }
  };

  walk(fn, (n) => {
    if (t.isAssignmentExpression(n)) {
      checkTarget(n.left);
    } else if (t.isUpdateExpression(n)) {
      checkTarget(n.argument);
    } else if (t.isForInStatement(n) || t.isForOfStatement(n)) {
      checkTarget(n.left);
    }
  });

  return names;
};

/** F 体内是否引用 `arguments` / `this`（提升与加前导参数都会改变其语义） */
const usesArgumentsOrThis = (fn: t.FunctionDeclaration): boolean => {
  let used = false;

  walk(fn, (n) => {
    if (t.isIdentifier(n) && n.name === "arguments") {
      used = true;
    }

    if (t.isThisExpression(n)) {
      used = true;
    }
  });

  return used;
};

/** F 是否嵌套在某个函数体内（模块顶层函数已天然接近 top-pure） */
const isInsideFunction = (path: NodePath<t.FunctionDeclaration>): boolean => {
  // Scope#parent 在根作用域返回 undefined（类型标注是 null），两者都要停
  let sc: Scope | null | undefined = path.scope.parent;

  while (sc !== null && sc !== undefined) {
    if (t.isFunction(sc.block)) {
      return true;
    }

    if (sc.block.type === "Program") {
      return false;
    }

    sc = sc.parent;
  }

  return false;
};

interface Capture {
  name: string;
  strategy: "hoist" | "param";
  binding: Binding;
}

interface Job {
  fnPath: NodePath<t.FunctionDeclaration>;
  fnName: string;
  fnNode: t.FunctionDeclaration;
  fnBinding: Binding;
  captures: Capture[];
  hoistFn: boolean;
}

const scopeIsAncestorOf = (anc: Scope | undefined, desc: Scope): boolean => {
  // Scope#parent 在根作用域返回 undefined（类型标注是 null），两者都要停
  let s: Scope | null | undefined = desc;

  while (s !== null && s !== undefined) {
    if (s === anc) {
      return true;
    }

    s = s.parent;
  }

  return false;
};

/** F 的自由名集合（排除 F 自身名字与 `arguments`） */
const freeNamesOf = (
  fn: t.FunctionDeclaration,
  fnName: string
): Set<string> => {
  const fnId = fn.id;
  const names = new Set<string>();

  walk(fn, (n, parent) => {
    if (!t.isIdentifier(n) || !isRefPosition(n, parent)) {
      return;
    }

    // 排除自身名字：递归自引用解析到 F 的声明（binding.scope 为祖先函数
    // 作用域），会被误判成"兄弟函数捕获"→ 同一节点被 remove 两次（踩坑实测）
    if (n === fnId || n.name === fnName || n.name === "arguments") {
      return;
    }

    names.add(n.name);
  });

  return names;
};

/** 单个自由名的分类结果：'ignore' = 与纯化无关，'giveup' = 该函数整体放弃 */
type CaptureVerdict = Capture | "ignore" | "giveup";

/** 自由名 → hoist/param 分类（F 自身声明、模块级绑定不算捕获） */
const classifyCapture = (
  fScope: Scope,
  name: string,
  mutated: ReadonlySet<string>
): CaptureVerdict => {
  const binding = fScope.getBinding(name);

  if (binding === undefined) {
    // 未定义全局：留给环境探针
    return "ignore";
  }

  if (binding.scope === fScope || scopeIsAncestorOf(fScope, binding.scope)) {
    // F 自身/内部声明
    return "ignore";
  }

  if (binding.scope.block.type === "Program") {
    // 模块级：已 top-pure
    return "ignore";
  }

  if (!scopeIsAncestorOf(binding.scope, fScope)) {
    // 非祖先（异常）→ 弃
    return "giveup";
  }

  if (!t.isFunction(binding.scope.block)) {
    // 祖先是块作用域 → Phase 1 弃
    return "giveup";
  }

  if (mutated.has(name)) {
    // F 内写捕获 → 弃
    return "giveup";
  }

  if (t.isVariableDeclarator(binding.path.node) && binding.constant) {
    if (binding.path.node.init !== null) {
      return { strategy: "hoist", name, binding };
    }
  } else if (
    // 兄弟函数：整函数提升
    t.isFunctionDeclaration(binding.path.node) &&
    binding.constant
  ) {
    return { strategy: "hoist", name, binding };
  }

  return { strategy: "param", name, binding };
};

interface CallSiteScan {
  callsites: NodePath<t.Identifier>[];
  escaped: boolean;
}

/** F 的全部名字引用必须是直接调用（可解析到同一绑定），否则视为逃逸 */
const scanCallSites = (
  ast: t.File,
  fnName: string,
  fnBinding: Binding
): CallSiteScan => {
  const callsites: NodePath<t.Identifier>[] = [];
  let escaped = false;

  const onIdentifierReference = (ip: NodePath<t.Identifier>): void => {
    if (ip.node.name !== fnName || !isRefPosition(ip.node, ip.parent)) {
      return;
    }

    // 声明处 id 与函数形参不算调用点
    if (
      ip.isBindingIdentifier?.() &&
      t.isFunctionDeclaration(ip.parent) &&
      ip.parent.id === ip.node
    ) {
      return;
    }

    if (ip.scope.getBinding(fnName) !== fnBinding) {
      // 同名其他绑定
      return;
    }

    const { parent } = ip;

    if (t.isCallExpression(parent) && parent.callee === ip.node) {
      callsites.push(ip);
    } else {
      escaped = true;
    }
  };

  traverse(ast, { Identifier: onIdentifierReference });

  return { callsites, escaped };
};

/** 节点自身或其祖先里是否有 fn（调用点是否落在 F 体内） */
const isWithinFn = (
  path: NodePath<t.Identifier>,
  fn: t.FunctionDeclaration
): boolean => {
  let p: NodePath | null = path;

  while (p !== null) {
    if (p.node === fn) {
      return true;
    }

    p = p.parentPath;
  }

  return false;
};

/** 参数化可行性：每个调用点对每个 param 捕获名解析到同一绑定 */
const paramCapturesResolvable = (
  captures: readonly Capture[],
  callsites: readonly NodePath<t.Identifier>[],
  fn: t.FunctionDeclaration
): boolean => {
  for (const c of captures) {
    if (c.strategy !== "param") {
      continue;
    }

    for (const cs of callsites) {
      // F 体内的自调用豁免——其内部将引用新参数
      if (isWithinFn(cs, fn)) {
        continue;
      }

      if (cs.scope.getBinding(c.name) !== c.binding) {
        return false;
      }
    }
  }

  return true;
};

/** 分析单个函数声明是否可纯化（不可行时登记 skip 并返回 null） */
const analyzeCandidate = (
  ast: t.File,
  path: NodePath<t.FunctionDeclaration>,
  skip: Set<string>
): Job | null => {
  const fn = path.node;
  const fnName = fn.id?.name;
  const key = `${fnName}@${fn.start}`;

  if (fnName === undefined || skip.has(key)) {
    return null;
  }

  if (!isInsideFunction(path)) {
    return null;
  }

  if (usesArgumentsOrThis(fn)) {
    skip.add(key);

    return null;
  }

  const fnBinding = path.scope.parent?.getBinding(fnName);

  if (fnBinding === undefined) {
    skip.add(key);

    return null;
  }

  // 自由变量分类：函数作用域捕获 → hoist/param；块作用域捕获/其他 → 弃
  const fScope = path.scope;
  const mutated = mutatedNames(fn);
  const captures: Capture[] = [];

  for (const name of freeNamesOf(fn, fnName)) {
    const verdict = classifyCapture(fScope, name, mutated);

    if (verdict === "giveup") {
      skip.add(key);

      return null;
    }

    if (verdict !== "ignore") {
      captures.push(verdict);
    }
  }

  if (captures.length === 0) {
    skip.add(key);

    return null;
  }

  // 逃逸检查：F 的全部名字引用必须是直接调用（可解析到同一绑定）
  const scan = scanCallSites(ast, fnName, fnBinding);

  if (scan.escaped || scan.callsites.length === 0) {
    skip.add(key);

    return null;
  }

  if (!paramCapturesResolvable(captures, scan.callsites, fn)) {
    skip.add(key);

    return null;
  }

  // F 是否可整体提升：直接声明在（某个）函数体的语句层
  const hoistFn =
    t.isBlockStatement(path.parent) && t.isFunction(path.parentPath?.parent);

  return {
    fnPath: path,
    fnNode: fn,
    fnName,
    fnBinding,
    captures,
    hoistFn,
  };
};

/** 找第一个可纯化的嵌套函数（不在 skip 集中） */
const findCandidate = (ast: t.File, skip: Set<string>): Job | null => {
  let found: Job | null = null;

  const onFunctionDeclaration = (
    path: NodePath<t.FunctionDeclaration>
  ): void => {
    if (found !== null || !path.node.id) {
      return;
    }

    found = analyzeCandidate(ast, path, skip);
  };

  traverse(ast, { FunctionDeclaration: onFunctionDeclaration });

  return found;
};

const findProgramPath = (ast: t.File): NodePath<t.Program> | null => {
  let programPath: NodePath<t.Program> | null = null;

  const onProgram = (path: NodePath<t.Program>): void => {
    programPath = path;
    path.stop();
  };

  traverse(ast, { Program: onProgram });

  return programPath;
};

/** 把一个 hoist 类捕获的声明搬移到模块顶层（false = 无法安全搬迁） */
const hoistDeclaration = (
  programPath: NodePath<t.Program>,
  c: Capture,
  fnPath: NodePath<t.FunctionDeclaration>
): boolean => {
  let { name } = c;

  if (programPath.scope.hasBinding(name, true)) {
    const newName = `${name}_lift`;

    c.binding.scope.rename(name, newName);
    name = newName;
  }

  const declPath = c.binding.path;

  if (declPath === fnPath) {
    // 防御：捕获即 F 自身（自引用漏网）
    return true;
  }

  const { node } = declPath;

  if (t.isVariableDeclarator(node)) {
    const { init } = node;

    if (init === null || init === undefined) {
      return false;
    }

    const stmt = t.variableDeclaration("var", [
      t.variableDeclarator(t.identifier(name), t.cloneNode(init, true)),
    ]);

    declPath.remove();
    programPath.node.body.unshift(stmt);

    return true;
  }

  if (t.isFunctionDeclaration(node)) {
    const fnNode = node;

    declPath.remove();
    programPath.node.body.unshift(t.cloneNode(fnNode, true));

    return true;
  }

  return false;
};

/** 参数化捕获：前导参数 + 调用点改写 */
const addLeadingParams = (
  ast: t.File,
  job: Job,
  paramCaptures: readonly Capture[]
): void => {
  job.fnNode.params.unshift(...paramCaptures.map((c) => t.identifier(c.name)));

  const onCallExpression = (cp: NodePath<t.CallExpression>): void => {
    const { callee } = cp.node;

    if (!t.isIdentifier(callee) || callee.name !== job.fnName) {
      return;
    }

    if (cp.scope.getBinding(job.fnName) !== job.fnBinding) {
      return;
    }

    // F 体内自调用：传（新）参数名；外部调用点：传当前值（同绑定已验证）
    cp.node.arguments.unshift(
      ...paramCaptures.map((c) => t.identifier(c.name))
    );
  };

  traverse(ast, { CallExpression: onCallExpression });
};

/** F 整体提升到模块顶层（重名时改名） */
const hoistFunction = (programPath: NodePath<t.Program>, job: Job): void => {
  if (
    programPath.scope.hasBinding(job.fnName, true) &&
    programPath.scope.getBinding(job.fnName) !== job.fnBinding
  ) {
    job.fnBinding.scope.rename(job.fnName, `${job.fnName}_lift`);
  }

  job.fnPath.remove();
  programPath.node.body.push(job.fnNode);
};

const applyJob = (ast: t.File, job: Job): boolean => {
  const programPath = findProgramPath(ast);

  if (programPath === null) {
    return false;
  }

  // ---------- 1) 提升类捕获：声明/函数搬移到模块顶层 ----------
  for (const c of job.captures) {
    if (c.strategy !== "hoist") {
      continue;
    }

    if (!hoistDeclaration(programPath, c, job.fnPath)) {
      return false;
    }
  }

  // ---------- 2) 参数化捕获：前导参数 + 调用点改写 ----------
  const paramCaptures = job.captures.filter((c) => c.strategy === "param");

  if (paramCaptures.length > 0) {
    addLeadingParams(ast, job, paramCaptures);
  }

  // ---------- 3) F 整体提升 ----------
  if (job.hoistFn) {
    hoistFunction(programPath, job);
  }

  return true;
};

export const purifyClosures: Transform = {
  name: "purify-closures",
  risk: "unsafe",
  // oxlint-disable-next-line eslint/require-await -- Transform.run 接口约定返回 Promise，本变换无异步步骤；去掉 async 会违反接口签名
  async run(ast) {
    const skip = new Set<string>();
    let purified = 0;
    let hoistedVars = 0;
    let paramed = 0;
    let rounds = 0;
    let job = findCandidate(ast, skip);

    // 每次处理后重新遍历（scope 全新）；处理数上限见 MAX_PURIFICATION_ROUNDS
    while (job !== null && rounds < MAX_PURIFICATION_ROUNDS) {
      rounds += 1;

      if (applyJob(ast, job)) {
        purified += 1;
        hoistedVars += job.captures.filter(
          (c) => c.strategy === "hoist"
        ).length;
        paramed += job.captures.filter((c) => c.strategy === "param").length;
      } else {
        skip.add(`${job.fnName}@${job.fnNode.start}`);
      }

      job = findCandidate(ast, skip);
    }

    if (purified === 0) {
      return result(false, ["no purification sites"]);
    }

    const notes = [`functions=${purified}`];

    if (hoistedVars > 0) {
      notes.push(`hoisted=${hoistedVars}`);
    }

    if (paramed > 0) {
      notes.push(`param=${paramed}`);
    }

    return result(true, notes);
  },
};
