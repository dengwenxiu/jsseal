/**
 * 通用纯调用折叠（fold-pure-calls）——purify-closures 的收益兑现：
 * top-pure 函数（自由变量全部解析到模块级**单赋值**绑定）在全字面量
 * 调用点上的返回值是常量 → 一次封闭求值 → 回填字面量。
 *
 * 这是 decoder-lookup-table 的**家族无关泛化**：不依赖 obfuscator.io 检测，
 * 任何形态的纯解码/工具函数（purify 提升后的池+解码器、自定义解密函数）
 * 都能折叠。种子有序屏障由静态门卫保证：Math.random/Date 等不在纯调用
 * 白名单 → 折叠不会删掉种子调用（锚库再兜底）。
 *
 * 静态门卫（保守，任一不满足即弃）：
 * - F 是模块顶层函数声明；自由变量的模块级绑定必须 binding.constant
 *   （单赋值——值在全程等于初始值）；未绑定全局必须在纯白名单
 *   （Math/String/parseInt…，console/document 等一律拒绝）
 * - F 体内：写目标（赋值/自增/delete）的根标识符必须在 F 内部绑定；
 *   禁 this/arguments/eval/new/with/yield/await/标签模板
 * - 调用白名单：纯内建（Math.floor/String.fromCharCode/字符串与数组的
 *   只读方法/JSON.parse…）或**候选集内的模块函数**（不动点收敛——
 *   decode 调 bufferToString，两者同时通过/同时出局）
 * - F 名字引用全部是直接调用（不逃逸）且解析到同一绑定
 *
 * 求值：当前代码 + 尾部驱动（逐调用点独立 try，走 __jsseal_ret_raw 通道）
 * → 只回填原始值（string/有限 number/boolean）。
 */

import type { NodePath, Scope } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse, generate } from "@jsseal/ast";
import { runSealed } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform } from "./types";

const PURE_GLOBALS = new Set([
  "Math",
  "String",
  "Number",
  "Boolean",
  "JSON",
  "Array",
  "Object",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "NaN",
  "Infinity",
  "undefined",
  "escape",
  "unescape",
  "encodeURI",
  "encodeURIComponent",
  "decodeURI",
  "decodeURIComponent",
]);

const PURE_MATH_FNS = new Set([
  "floor",
  "ceil",
  "round",
  "abs",
  "min",
  "max",
  "pow",
  "sqrt",
  "cbrt",
  "trunc",
  "sign",
  "hypot",
  "imul",
  "clz32",
  "fround",
  "log2",
  "log10",
  "exp",
  "log",
  "expm1",
  "log1p",
  "sin",
  "cos",
  "tan",
  "atan",
  "atan2",
  "asin",
  "acos",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
]);

const PURE_INSTANCE_METHODS = new Set([
  // 字符串与数组的只读方法（push/pop/sort/reverse/splice/fill 等变异方法一律不在）
  "charAt",
  "charCodeAt",
  "codePointAt",
  "at",
  "indexOf",
  "lastIndexOf",
  "includes",
  "startsWith",
  "endsWith",
  "slice",
  "substring",
  "substr",
  "toUpperCase",
  "toLowerCase",
  "trim",
  "trimStart",
  "trimEnd",
  "padStart",
  "padEnd",
  "repeat",
  "split",
  "concat",
  "toString",
  "valueOf",
  "localeCompare",
  "normalize",
  "join",
]);

const PURE_STRING_STATIC = new Set(["fromCharCode", "fromCodePoint"]);

/** 折叠值域：只回填原始值（对象/数组/undefined 一律不折叠） */
type FoldValue = string | number | boolean;

/** 全字面量实参的调用点 + 折叠方向守卫所需信息 */
interface CallSite {
  path: NodePath<t.CallExpression>;
  text: string;
  strArg: boolean;
  strArgValue?: string;
}

/** 模块顶层函数声明与其作用域（候选集的输入） */
interface ModuleFunctions {
  fns: Map<string, t.FunctionDeclaration>;
  scope: Scope;
}

/** 回填计数：folded = 成功折叠数，skippedCodec = 方向守卫拦下的字符串折叠数 */
interface FoldCounts {
  folded: number;
  skippedCodec: number;
}

/** 调用是否纯内建（静态白名单；callee 含 V8IntrinsicIdentifier 联合类型故收 t.Node） */
const isPureBuiltinCall = (callee: t.Node): boolean => {
  if (t.isIdentifier(callee)) {
    return PURE_GLOBALS.has(callee.name);
  }

  if (
    !t.isMemberExpression(callee) ||
    callee.computed ||
    !t.isIdentifier(callee.property)
  ) {
    return false;
  }

  const obj = callee.object;
  const m = callee.property.name;

  if (t.isIdentifier(obj)) {
    if (obj.name === "Math") {
      return PURE_MATH_FNS.has(m);
    }

    if (obj.name === "String") {
      return PURE_STRING_STATIC.has(m);
    }

    if (obj.name === "JSON") {
      return m === "parse" || m === "stringify";
    }

    if (obj.name === "Number") {
      return ["parseInt", "parseFloat", "isFinite", "isNaN"].includes(m);
    }
  }

  // 实例方法按名白名单：接收者为参数（字面量实参→原始值）或 F 内构造的局部对象
  //（其方法体同样经过本门卫扫描），无外部可变异接收者
  return PURE_INSTANCE_METHODS.has(m);
};

/** 密文态启发：非字母数字非空白符号占比高（≥0.35）且非纯数字串 */
const looksOpaque = (s: string): boolean => {
  if (!s) {
    return false;
  }

  // oxlint-disable-next-line eslint/require-unicode-regexp -- 加 u 标记会让 [^\w\s] 按码点计数（代理对算 1）而比例分母仍是 UTF-16 长度，含 emoji/罕见字符的密文判定会变，阈值是实测标定的
  const symbols = (s.match(/[^\w\s]/g) ?? []).length;

  return symbols / s.length >= 0.35;
};

/** 明文态启发：字母/数字/空白占比高（≥0.9）且含至少 3 连字母（像自然/标识符文本） */
const looksTexty = (s: string): boolean => {
  if (!s) {
    return false;
  }

  const ok = (s.match(/[\w\s]/gu) ?? []).length;

  return ok / s.length >= 0.9 && /[a-zA-Z]{3,}/u.test(s);
};

/** 折叠值域判定：字符串/布尔/有限数字（Infinity 经 JSON 通道变 null，此处再兜一层） */
const isFoldValue = (value: unknown): value is FoldValue =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

/** 驱动回读条目：驱动侧写入值与类型标记两个字段，回读时逐个判形 */
interface FoldedEntry {
  v: unknown;
}

/** 回读条目判定：条目必须是非 null 对象且带值字段 v */
const isFoldedEntry = (entry: unknown): entry is FoldedEntry => {
  if (typeof entry !== "object" || entry === null) {
    return false;
  }

  return "v" in entry;
};

/** 字符串值判定（回填节点与方向守卫共用） */
const isStringValue = (value: FoldValue): value is string =>
  typeof value === "string";

/** 布尔值判定（回填节点用） */
const isBooleanValue = (value: FoldValue): value is boolean =>
  typeof value === "boolean";

/** 回填节点：字符串/布尔/数字 → 对应字面量 */
const toLiteral = (
  value: FoldValue
): t.StringLiteral | t.BooleanLiteral | t.NumericLiteral => {
  if (isStringValue(value)) {
    return t.stringLiteral(value);
  }

  if (isBooleanValue(value)) {
    return t.booleanLiteral(value);
  }

  return t.numericLiteral(value);
};

/**
 * 全字面量原始参数（含一元负数）的调用点 → 生成文本；否则 null。
 * 用 generate 现场打印而非 ctx.code 偏移切片：同轮前置变换（如
 * propagate-constants）改过 AST 后，node.start 与重打印文本错位——
 * 实测曾切出残缺片段使驱动 SyntaxError（expecting ';'）
 */
const literalArgsText = (call: t.CallExpression): string | null => {
  for (const arg of call.arguments) {
    if (!isLiteralCallArg(arg)) {
      return null;
    }
  }

  return generate(call).code;
};

/** 单个实参是否可直接打印的字面量（含一元负数） */
const isLiteralCallArg = (arg: t.Node | null | undefined): boolean => {
  const plainLiteral =
    t.isStringLiteral(arg) ||
    t.isNumericLiteral(arg) ||
    t.isBooleanLiteral(arg) ||
    t.isNullLiteral(arg);

  const negativeNumber =
    t.isUnaryExpression(arg, { operator: "-" }) &&
    t.isNumericLiteral(arg.argument);

  return plainLiteral || negativeNumber;
};

/** 首个字符串实参的值（折叠方向守卫用）；无字符串实参 → undefined */
const firstStringArg = (call: t.CallExpression): string | undefined => {
  for (const arg of call.arguments) {
    if (t.isStringLiteral(arg)) {
      return arg.value;
    }
  }

  return undefined;
};

/** AST 节点判定：AST 是开放结构（节点类型众多），只能按 type 字段探形 */
const isAstNode = (value: unknown): value is t.Node => {
  if (value === null || typeof value !== "object") {
    return false;
  }

  return "type" in value;
};

/** 节点的直接子节点（跳过源码位置与注释字段，按字段声明序下降） */
const childNodesOf = (node: t.Node): t.Node[] => {
  const children: t.Node[] = [];

  for (const [key, field] of Object.entries(node)) {
    if (key === "loc" || key.endsWith("Comments")) {
      continue;
    }

    const value: unknown = field;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (isAstNode(item)) {
          children.push(item);
        }
      }
    } else if (isAstNode(value)) {
      children.push(value);
    }
  }

  return children;
};

/** 通用子树下钻（带父节点）；visit 返回 false 即整体否决 */
const walk = (
  node: t.Node,
  visit: (n: t.Node, parent: t.Node | null) => boolean
): boolean => {
  let keep = true;

  const rec = (n: t.Node, parent: t.Node | null): void => {
    if (!keep) {
      return;
    }

    if (!visit(n, parent)) {
      keep = false;

      return;
    }

    for (const child of childNodesOf(n)) {
      rec(child, n);
    }
  };

  rec(node, null);

  return keep;
};

/** Identifier 是否处于被引用位置（排除非计算成员属性名等） */
const isRefPos = (node: t.Identifier, parent: t.Node | null): boolean => {
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

  if (t.isObjectMethod(parent) && !parent.computed && parent.key === node) {
    return false;
  }

  return true;
};

/** F 内部绑定的名字集合（自身形参/局部声明/嵌套函数形参与声明/catch 参数） */
const collectLocalNames = (fn: t.FunctionDeclaration): Set<string> => {
  const names = new Set<string>();

  if (fn.id) {
    names.add(fn.id.name);
  }

  /** 绑定模式里的名字（形参/解构元素/catch 参数） */
  const addPattern = (pattern: t.Node | null | undefined): void => {
    if (!pattern) {
      return;
    }

    if (t.isIdentifier(pattern)) {
      names.add(pattern.name);
    } else if (t.isAssignmentPattern(pattern)) {
      addPattern(pattern.left);
    } else if (t.isRestElement(pattern)) {
      addPattern(pattern.argument);
    } else if (t.isArrayPattern(pattern)) {
      for (const element of pattern.elements) {
        addPattern(element);
      }
    } else if (t.isObjectPattern(pattern)) {
      for (const property of pattern.properties) {
        addPattern(t.isRestElement(property) ? property : property.value);
      }
    }
  };

  walk(fn, (node) => {
    if (t.isFunction(node)) {
      for (const param of node.params) {
        addPattern(param);
      }
    }

    if (t.isVariableDeclarator(node)) {
      addPattern(node.id);
    }

    if (t.isFunctionDeclaration(node) && node.id) {
      names.add(node.id.name);
    }

    if (t.isCatchClause(node) && node.param) {
      addPattern(node.param);
    }

    return true;
  });

  return names;
};

/** 一票否决的节点形态（依赖 this/上下文或求值顺序不可静态确定） */
const isVetoedNode = (node: t.Node): boolean => {
  const contextDependent =
    t.isThisExpression(node) ||
    t.isWithStatement(node) ||
    t.isNewExpression(node) ||
    t.isYieldExpression(node);

  const suspensionOrDynamic =
    t.isAwaitExpression(node) || t.isTaggedTemplateExpression(node);

  return contextDependent || suspensionOrDynamic;
};

/** arguments/eval 的动态绑定引用（无法静态求值） */
const isDynamicBindingRef = (node: t.Node, parent: t.Node | null): boolean =>
  t.isIdentifier(node) &&
  isRefPos(node, parent) &&
  (node.name === "arguments" || node.name === "eval");

/** 写/删目标（赋值/自增/自减/delete）的左值；非写目标 → null */
const writeTargetRoot = (node: t.Node): t.Node | null => {
  if (t.isAssignmentExpression(node)) {
    return node.left;
  }

  if (t.isUpdateExpression(node)) {
    return node.argument;
  }

  if (t.isUnaryExpression(node) && node.operator === "delete") {
    return node.argument;
  }

  return null;
};

/** 写目标必须落在 F 内部绑定上（不改外部状态） */
const isLocalWriteTarget = (root: t.Node, localNames: Set<string>): boolean => {
  let target = root;

  while (t.isMemberExpression(target)) {
    target = target.object;
  }

  return t.isIdentifier(target) && localNames.has(target.name);
};

/** 调用白名单：纯内建 / 自递归 / 局部函数 / 候选集模块函数（不动点） */
const isAllowedCallee = (
  callee: t.Node,
  fnName: string,
  localNames: Set<string>,
  candidateSet: Set<string>
): boolean => {
  if (isPureBuiltinCall(callee)) {
    return true;
  }

  if (!t.isIdentifier(callee)) {
    return false;
  }

  return (
    callee.name === fnName ||
    localNames.has(callee.name) ||
    candidateSet.has(callee.name)
  );
};

/** 自由标识符：局部/自引用为真；模块绑定必须单赋值；未绑定全局必须在纯白名单 */
const isAllowedFreeIdentifier = (
  node: t.Identifier,
  parent: t.Node | null,
  fnName: string,
  localNames: Set<string>,
  programScope: Scope
): boolean => {
  // 属性名/键位：不是引用
  if (!isRefPos(node, parent)) {
    return true;
  }

  if (localNames.has(node.name) || node.name === fnName) {
    return true;
  }

  const binding = programScope.getBinding(node.name);

  // 未绑定全局：纯白名单
  if (binding === undefined) {
    return PURE_GLOBALS.has(node.name);
  }

  // 模块绑定必须单赋值
  if (binding.scope.block.type === "Program") {
    return binding.constant;
  }

  return false;
};

/** 单个候选函数是否通过门卫（candidateSet 供调用不动点） */
const passesGates = (
  fn: t.FunctionDeclaration,
  fnName: string,
  candidateSet: Set<string>,
  programScope: Scope
): boolean => {
  const localNames = collectLocalNames(fn);

  return walk(fn, (node, parent) => {
    if (isVetoedNode(node) || isDynamicBindingRef(node, parent)) {
      return false;
    }

    const targetRoot = writeTargetRoot(node);

    if (targetRoot !== null) {
      return isLocalWriteTarget(targetRoot, localNames);
    }

    if (t.isCallExpression(node)) {
      return isAllowedCallee(node.callee, fnName, localNames, candidateSet);
    }

    if (t.isIdentifier(node)) {
      return isAllowedFreeIdentifier(
        node,
        parent,
        fnName,
        localNames,
        programScope
      );
    }

    return true;
  });
};

/** 调用点收集结果：按函数名分组的可折叠调用点 + 逃逸函数名 */
interface CallSiteScan {
  sitesByFn: Map<string, CallSite[]>;
  escapeFns: Set<string>;
}

/** 模块顶层函数声明 + Program 作用域（无 Program 视为不适用） */
const collectModuleFunctions = (ast: t.File): ModuleFunctions | null => {
  const fns = new Map<string, t.FunctionDeclaration>();
  let programScope: Scope | undefined;

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
    Program: (path) => {
      programScope = path.scope;

      for (const statement of path.node.body) {
        if (t.isFunctionDeclaration(statement) && statement.id) {
          fns.set(statement.id.name, statement);
        }
      }
    },
  });

  if (programScope === undefined) {
    return null;
  }

  return { fns, scope: programScope };
};

/** 候选集不动点：候选互相调用时同时通过/同时出局 */
const pureCandidateNames = (
  fns: Map<string, t.FunctionDeclaration>,
  programScope: Scope
): Set<string> => {
  let candidates = new Set(fns.keys());

  for (let iter = 0; iter < 8; iter += 1) {
    const next = new Set<string>();

    for (const [name, fn] of fns) {
      if (
        candidates.has(name) &&
        passesGates(fn, name, candidates, programScope)
      ) {
        next.add(name);
      }
    }

    if (next.size === candidates.size) {
      break;
    }

    candidates = next;
  }

  return candidates;
};

/** 声明处（函数名本身）不算引用 */
const isBindingDeclaration = (path: NodePath<t.Identifier>): boolean =>
  t.isFunctionDeclaration(path.parent) && path.parent.id === path.node;

/**
 * 调用点收集：解析到模块绑定的引用中，直接调用 + 全字面量实参 → 折叠候选；
 * 其它引用（赋值/传参/属性挂载）一律记为逃逸——逃逸者的调用点不可枚举。
 */
const collectCallSites = (
  ast: t.File,
  candidates: Set<string>
): CallSiteScan => {
  const sitesByFn = new Map<string, CallSite[]>();
  const escapeFns = new Set<string>();

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- 访问器键名由 Babel 固定为 AST 节点类型名（PascalCase），改写成 camelCase 就不再是访问器
    Identifier: (path) => {
      const { name } = path.node;

      if (!candidates.has(name) || isBindingDeclaration(path)) {
        return;
      }

      // 同名不同绑定（局部遮蔽）：与本次折叠无关
      const binding = path.scope.getBinding(name);

      if (binding === undefined || binding.scope.block.type !== "Program") {
        return;
      }

      const callPath = path.parentPath;

      if (
        callPath === null ||
        !callPath.isCallExpression() ||
        callPath.node.callee !== path.node
      ) {
        // 任何非调用引用 = 逃逸
        escapeFns.add(name);

        return;
      }

      const text = literalArgsText(callPath.node);

      if (text === null) {
        return;
      }

      const list = sitesByFn.get(name) ?? [];
      const strArgValue = firstStringArg(callPath.node);

      list.push({
        path: callPath,
        strArg: strArgValue !== undefined,
        strArgValue,
        text,
      });
      sitesByFn.set(name, list);
    },
  });

  return { sitesByFn, escapeFns };
};

/** JSON 数组边界解析（驱动回读通道）：语法错误或非数组 → null */
const parseJsonArray = (raw: string | undefined): unknown[] | null => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  // SAFETY: Array.isArray 已确认是数组；元素类型刻意退化为 unknown，由 isFoldedEntry/isFoldValue 逐个判形
  return parsed as unknown[];
};

/** 驱动回读 → 调用点文本 → 原始值（同一文本只求值一次） */
const collectFoldedValues = (
  texts: string[],
  entries: unknown[]
): Map<string, FoldValue> => {
  const valueByText = new Map<string, FoldValue>();

  for (const [index, text] of texts.entries()) {
    const entry: unknown = entries[index];
    const value: unknown = isFoldedEntry(entry) ? entry.v : undefined;

    if (isFoldValue(value)) {
      valueByText.set(text, value);
    }
  }

  return valueByText;
};

/**
 * 折叠方向守卫（可读性启发式）：字符串→字符串的折叠分不清加密/解密方向——
 * encrypt("明文") 折回密文是还原度负优化（实测：把 inline-decoder 刚
 * 内联的明文又加密回去）。只放行"解密方向"：入参不透明（符号密文态）
 * 且返回值文本化（字母/空格为主）。启发式不保证语义方向，只保证
 * 折叠朝可读性增益的方向；错误方向被锚库兜底（行为恒等）
 */
const isDecryptDirection = (site: CallSite, value: FoldValue): boolean =>
  !site.strArg ||
  !isStringValue(value) ||
  (looksOpaque(String(site.strArgValue)) && looksTexty(value));

/** 回填：只回填原始值，方向守卫拦下的计为 codec */
const replaceCallSites = (
  sitesByFn: Map<string, CallSite[]>,
  valueByText: Map<string, FoldValue>
): FoldCounts => {
  let folded = 0;
  let skippedCodec = 0;

  for (const sites of sitesByFn.values()) {
    for (const site of sites) {
      const value = valueByText.get(site.text);

      if (value === undefined) {
        continue;
      }

      if (isDecryptDirection(site, value)) {
        try {
          site.path.replaceWith(toLiteral(value));
          folded += 1;
        } catch {
          /* skip */
        }
      } else {
        skippedCodec += 1;
      }
    }
  }

  return { folded, skippedCodec };
};

export const foldPureCalls: Transform = {
  name: "fold-pure-calls",
  risk: "unsafe",
  async run(ast, ctx) {
    // ---------- 1) 候选集：模块顶层函数声明（不动点收敛） ----------
    const module = collectModuleFunctions(ast);

    if (module === null || module.fns.size === 0) {
      return result(false, ["no module functions"]);
    }

    const candidates = pureCandidateNames(module.fns, module.scope);

    if (candidates.size === 0) {
      return result(false, ["no pure candidates"]);
    }

    // ---------- 2) 调用点收集（同绑定 + 不逃逸 + 字面量参数） ----------
    const { sitesByFn, escapeFns } = collectCallSites(ast, candidates);

    for (const [name, sites] of sitesByFn) {
      if (escapeFns.has(name) || sites.length === 0) {
        sitesByFn.delete(name);
      }
    }

    if (sitesByFn.size === 0) {
      return result(false, [`candidates=${candidates.size} no literal sites`]);
    }

    // ---------- 3) 封闭求值（当前代码 + 尾部驱动，__jsseal_ret_raw 通道） ----------
    const texts = [
      ...new Set([...sitesByFn.values()].flat().map((s) => s.text)),
    ];

    const lines = texts.map((x, i) => `try{__pr[${i}]=__pf((${x}))}catch(e){}`);

    const driver = `var __pf=function(x){return {v:x,s:typeof x}};var __pr=[];\n${lines.join(
      "\n"
    )}\nglobalThis.__jsseal_ret_raw = JSON.stringify(__pr);`;

    let out;

    try {
      out = await runSealed({
        code: `${ctx.code}\n${driver}`,
        mode: "record",
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch {
      return result(false, ["eval fault"]);
    }

    if (!out.ok || out.flags.timeout === true || out.flags.oom === true) {
      return result(false, [`eval fault: ${JSON.stringify(out.flags)}`]);
    }

    const entries = parseJsonArray(out.ret);

    if (entries === null) {
      return result(false, ["eval parse fault"]);
    }

    if (entries.length !== texts.length) {
      return result(false, ["eval shape fault"]);
    }

    // ---------- 4) 回填（只回填原始值） ----------
    const valueByText = collectFoldedValues(texts, entries);
    const { folded, skippedCodec } = replaceCallSites(sitesByFn, valueByText);

    if (folded === 0) {
      const guardNote =
        skippedCodec > 0 ? ` (codec-guard=${skippedCodec})` : "";

      return result(false, [`no foldable values${guardNote}`]);
    }

    const notes = [
      `fns=${sitesByFn.size}`,
      `folded=${folded}`,
      `candidates=${candidates.size}`,
    ];

    if (skippedCodec > 0) {
      notes.push(`codec-guard=${skippedCodec}`);
    }

    return result(true, notes);
  },
};
