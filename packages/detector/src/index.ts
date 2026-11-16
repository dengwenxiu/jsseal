/**
 * `@jsseal/detector` — 混淆家族识别（定向类操作：允许启发式，输出是假设，不承担恒等责任）
 *
 * 职责：
 *  1. 家族识别（obfuscator.io / sojson / jsjiami / awsc / packer / jsfuck / jjencode / aaencode / webpack / minified）
 *  2. obfuscator.io 解码三件套提取（字符串数组函数 / 轮转 IIFE / 解码函数）——
 *     输出可在封闭运行时独立执行的 prologue 源码切片
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { parseCode, traverse } from "@jsseal/ast";

export type Family =
  | "obfuscator-io"
  | "jsconfuser"
  | "sojson"
  | "jsjiami"
  | "awsc"
  | "packer"
  | "jsfuck"
  | "jjencode"
  | "aaencode"
  | "webpack"
  | "minified"
  | "plain"
  | "unknown";

export interface ObfuscatorIOPlan {
  /** 解码函数名（调用点形如 name(idx[, key])） */
  decoderNames: string[];
  /** 字符串数组函数名 */
  stringArrayNames: string[];
  /** prologue 源码切片（含三件套，源码顺序拼接，可在封闭运行时独立执行） */
  prologueSource: string;
  /** 轮转 IIFE 的语句位置数（报告用） */
  rotateCount: number;
}

export interface Detection {
  family: Family;
  confidence: number;
  features: string[];
  obfuscatorIO?: ObfuscatorIOPlan;
}

const HEX_NAME = /^_?0x[0-9a-fA-F]{3,}$/u;

/** Babel 节点上的元数据字段：不是子节点，结构遍历时跳过 */
const NODE_METADATA_KEYS = new Set([
  "loc",
  "leadingComments",
  "trailingComments",
]);

/** 数组变异方法：池轮转 IIFE 的操作特征 */
const ARRAY_MUTATORS = new Set([
  "push",
  "shift",
  "unshift",
  "pop",
  "reverse",
  "splice",
  "sort",
  "copyWithin",
  "fill",
]);

/** 解码原语（仅作特征记录：encoding:'none' 的解码器没有这些调用） */
const DECODE_PRIMITIVES = new Set([
  "fromCharCode",
  "charCodeAt",
  "charAt",
  "push",
  "shift",
]);

/** 成员属性名：标识符与字符串字面量可直接取名；计算属性等形态返回空串 */
const memberPropertyName = (prop: t.MemberExpression["property"]): string => {
  if (t.isIdentifier(prop)) {
    return prop.name;
  }

  if (t.isStringLiteral(prop)) {
    return prop.value;
  }

  return "";
};

/** 源码区间齐全才可切片（Babel 合成节点可能缺 start/end） */
const hasSourceRange = (
  node: t.Node
): node is t.Node & { start: number; end: number } =>
  node.start !== null &&
  node.start !== undefined &&
  node.end !== null &&
  node.end !== undefined;

/** 结构遍历 Babel 节点的直接子节点（跳过 loc/注释元数据；子节点由 isNode 判定） */
const forEachChildNode = (
  node: t.Node,
  visit: (child: t.Node) => void
): void => {
  for (const [key, value] of Object.entries(node)) {
    if (NODE_METADATA_KEYS.has(key)) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (t.isNode(item)) {
          visit(item);
        }
      }
    } else if (t.isNode(value)) {
      visit(value);
    }
  }
};

/** 统计函数体内字符串字面量数组的规模（允许混合元素——sojson v7 首元素是标识符） */
const bigStringArraySize = (fn: NodePath<t.FunctionDeclaration>): number => {
  let best = 0;

  fn.traverse({
    // oxlint-disable-next-line sonarjs/function-name -- Babel 访问者键名必须是节点类型名，无法改写成 camelCase
    ArrayExpression(p) {
      const els = p.node.elements;
      const strCount = els.filter((e) => t.isStringLiteral(e)).length;

      if (els.length >= 8 && strCount >= 8) {
        best = Math.max(best, els.length);
      }
    },
  });

  return best;
};

const truthyLike = (test: t.Expression): boolean => {
  if (t.isBooleanLiteral(test)) {
    return test.value;
  }

  // !![]
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

/** 函数体是否包含 "while(true) + push/shift" 轮转特征 */
const containsRotateWhile = (fn: t.FunctionExpression): boolean => {
  let hasWhile = false;
  let hasPushShift = false;

  const visit = (node: t.Node): void => {
    if (t.isWhileStatement(node) && truthyLike(node.test)) {
      hasWhile = true;
    }

    if (t.isMemberExpression(node)) {
      const name = memberPropertyName(node.property);

      if (name === "push" || name === "shift") {
        hasPushShift = true;
      }
    }

    forEachChildNode(node, visit);
  };

  forEachChildNode(fn.body, visit);

  return hasWhile && hasPushShift;
};

/** 表达式语句是否为 obfuscator.io 轮转 IIFE（经典形态：while(!![])+push/shift） */
export const isRotateStatement = (node: t.ExpressionStatement): boolean => {
  const expr = node.expression;

  if (!t.isCallExpression(expr) || !t.isFunctionExpression(expr.callee)) {
    return false;
  }

  return containsRotateWhile(expr.callee);
};

/**
 * 通用池变换器识别（sojson v7 教训：轮转可为 for 循环 + reverse/push 等任意形态）：
 * 顶层 IIFE（Function/Arrow）子树同时满足 ① 引用池函数名 ② 含数组变异成员调用。
 * names 为空时退化为经典形态判定。
 */
export const isPoolRotatorStatement = (
  node: t.ExpressionStatement,
  poolNames?: Set<string>
): boolean => {
  if (!poolNames || poolNames.size === 0) {
    return isRotateStatement(node);
  }

  const expr: t.Expression = node.expression;

  /* 序列表达式解包（sojson v7：IIFE(190), _0x2c4c && (...) 逗号连接为一条语句） */
  const candidates: t.Expression[] = t.isSequenceExpression(expr)
    ? [...expr.expressions]
    : [expr];

  const target = candidates.find(
    (e) =>
      t.isCallExpression(e) &&
      (t.isFunctionExpression(e.callee) ||
        t.isArrowFunctionExpression(e.callee))
  );

  if (!target || !t.isCallExpression(target)) {
    return false;
  }

  let refsPool = false;
  let hasMutator = false;

  const visit = (child: t.Node): void => {
    if (refsPool && hasMutator) {
      return;
    }

    if (t.isIdentifier(child) && poolNames.has(child.name)) {
      refsPool = true;
    }

    if (t.isMemberExpression(child)) {
      if (ARRAY_MUTATORS.has(memberPropertyName(child.property))) {
        hasMutator = true;
      }

      /* sojson v7：方法名为变量/表达式（i[c]()、i["un"+c](e)）——计算成员调用
       * 结合"引用池函数名 + 顶层 IIFE"已足够特异 */
      if (
        child.computed &&
        !t.isStringLiteral(child.property) &&
        !t.isNumericLiteral(child.property)
      ) {
        hasMutator = true;
      }
    }

    forEachChildNode(child, visit);
  };

  /* 经典 obfuscator.io 形态把池作为 IIFE 实参（引用在 arguments）；
   * sojson 形态在体内引用——walk 整个调用表达式（callee+arguments） */
  forEachChildNode(target, visit);

  return refsPool && hasMutator;
};

/** 字符串级家族签名判定：顺序即优先级（先命中先返回），特征写入 features */
const detectStringFamily = (
  code: string,
  features: string[]
): Detection | null => {
  const src = code.slice(0, 4096);

  // ---------- 字符串级家族 ----------
  if (
    /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)/u.test(
      code
    )
  ) {
    features.push("packer-signature");

    return { family: "packer", confidence: 0.99, features };
  }

  const nonJsfuck = code.replaceAll(/[[\]()!+]/gu, "");

  if (code.length > 200 && nonJsfuck.length / code.length < 0.15) {
    features.push("jsfuck-charset");

    return { family: "jsfuck", confidence: 0.95, features };
  }

  if (src.includes("$=~[]") || /\$\s*=\s*~\s*\[\]/u.test(src)) {
    features.push("jjencode-signature");

    return { family: "jjencode", confidence: 0.9, features };
  }

  if (code.includes("ﾟωﾟ") || code.includes("(ﾟｰﾟ)")) {
    features.push("aaencode-signature");

    return { family: "aaencode", confidence: 0.9, features };
  }

  if (code.includes("sojson") || code.includes("SOJSON")) {
    features.push("sojson-marker");

    return { family: "sojson", confidence: 0.8, features };
  }

  if (/__p_[a-zA-Z0-9]{4}_cff_/u.test(code)) {
    features.push("jsconfuser-cff-signature");

    return { family: "jsconfuser", confidence: 0.85, features };
  }

  if (/jsjiami/iu.test(code)) {
    /* sojson/jsjiami 是 obfuscator.io 衍生——标记不短路：三件套若能提取，
     * 走 obfuscator-io 管线（实测 sojson v7 教训：提前 return 导致提取从未运行） */
    features.push("jsjiami-marker");
  } else if (code.includes("awsc") || code.includes("aliyun-oss-rs")) {
    features.push("awsc-marker");
  }

  if (
    code.includes("__webpack_require__") ||
    code.includes("webpackBootstrap")
  ) {
    features.push("webpack-runtime");

    return { family: "webpack", confidence: 0.95, features };
  }

  return null;
};

/** 顶层字面量声明的源码切片：仅当 prologue 引用了该名字且区间齐全时才有意义 */
const literalDeclSource = (
  d: t.VariableDeclarator,
  code: string,
  prologueBody: string
): string | null => {
  if (!t.isIdentifier(d.id) || !d.init || !t.isLiteral(d.init)) {
    return null;
  }

  const referenced = new RegExp(`\\b${d.id.name}\\b`, "u").test(prologueBody);

  if (!referenced || !hasSourceRange(d.init)) {
    return null;
  }

  return `var ${d.id.name} = ${code.slice(d.init.start, d.init.end)};`;
};

/** 三件套切片可能引用切片外的顶层字面量声明（sojson v7 教训：首元素是全局 version_）
 * —— 纳入被引用的顶层字面量声明，保证 prologue 可独立执行 */
const collectPreludeDecls = (
  body: t.Statement[],
  code: string,
  prologueBody: string
): string[] => {
  const decls: string[] = [];

  try {
    for (const stmt of body) {
      if (!t.isVariableDeclaration(stmt)) {
        continue;
      }

      for (const d of stmt.declarations) {
        const decl = literalDeclSource(d, code, prologueBody);

        if (decl !== null) {
          decls.push(decl);
        }
      }
    }
  } catch {
    /* 顶层声明无法纳入 prelude 时放弃字面量预置（不牺牲三件套本身） */
  }

  return decls;
};

export const detect = (code: string): Detection => {
  const features: string[] = [];
  const stringFamily = detectStringFamily(code, features);

  if (stringFamily) {
    return stringFamily;
  }

  // ---------- AST 级特征（obfuscator.io） ----------
  let ast: ReturnType<typeof parseCode>;

  try {
    ast = parseCode(code);
  } catch {
    return { family: "unknown", confidence: 0, features: ["parse-failed"] };
  }

  let hexNameCount = 0;
  const stringArrayFns: NodePath<t.FunctionDeclaration>[] = [];

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- Babel 访问者键名必须是节点类型名，无法改写成 camelCase
    Identifier(path) {
      if (HEX_NAME.test(path.node.name)) {
        hexNameCount += 1;
      }
    },
    // oxlint-disable-next-line sonarjs/function-name -- Babel 访问者键名必须是节点类型名，无法改写成 camelCase
    FunctionDeclaration(path) {
      if (bigStringArraySize(path) >= 8) {
        stringArrayFns.push(path);
        features.push(`string-array-fn:${path.node.id?.name}(n>=8)`);
      }
    },
  });

  // 池变换器收集（二段：需要先拿到数组函数名——sojson v7 的轮转是 for+reverse/push 形态，
  // 经典 while+push/shift 判定漏识别导致 prologue 池为轮转前状态、inline 全错——实测教训）
  const rotateIIFENodes: t.Statement[] = [];
  const rotateSlices: string[] = [];
  const stringArrayNames = new Set<string>();

  for (const fnPath of stringArrayFns) {
    const name = fnPath.node.id?.name;

    if (name !== undefined) {
      stringArrayNames.add(name);
    }
  }

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- Babel 访问者键名必须是节点类型名，无法改写成 camelCase
    ExpressionStatement(path) {
      if (isPoolRotatorStatement(path.node, stringArrayNames)) {
        rotateIIFENodes.push(path.node);

        if (hasSourceRange(path.node)) {
          rotateSlices.push(code.slice(path.node.start, path.node.end));
        }

        features.push("rotate-iife");
      }
    },
  });

  // 解码函数：非字符串数组函数，引用了字符串数组名，或包含典型解码原语
  const decoderNames: string[] = [];
  const decoderSlices: string[] = [];

  traverse(ast, {
    // oxlint-disable-next-line sonarjs/function-name -- Babel 访问者键名必须是节点类型名，无法改写成 camelCase
    FunctionDeclaration(path) {
      const name = path.node.id?.name;

      if (name === undefined) {
        return;
      }

      if (stringArrayNames.has(name)) {
        return;
      }

      if (stringArrayFns.some((sa) => sa.node === path.node)) {
        return;
      }

      let refsArray = false;
      let hasDecodePrimitive = false;

      path.traverse({
        // oxlint-disable-next-line sonarjs/function-name -- Babel 访问者键名必须是节点类型名，无法改写成 camelCase
        Identifier(ip) {
          if (stringArrayNames.has(ip.node.name)) {
            refsArray = true;
          }
        },
        // oxlint-disable-next-line sonarjs/function-name -- Babel 访问者键名必须是节点类型名，无法改写成 camelCase
        MemberExpression(mp) {
          if (DECODE_PRIMITIVES.has(memberPropertyName(mp.node.property))) {
            hasDecodePrimitive = true;
          }
        },
      });

      // 解码函数判定：引用了字符串数组函数名即候选（encoding:'none' 时解码器
      // 只是索引+偏移，没有 fromCharCode/charAt 等原语；primitives 仅作特征记录）
      if (refsArray) {
        decoderNames.push(name);

        if (hasSourceRange(path.node)) {
          decoderSlices.push(code.slice(path.node.start, path.node.end));
        }

        if (hasDecodePrimitive) {
          features.push(`decoder-primitives:${name}`);
        }
      }
    },
  });

  if (
    stringArrayFns.length > 0 &&
    (decoderNames.length > 0 || rotateIIFENodes.length > 0)
  ) {
    const arraySlices = stringArrayFns.map((fnPath) =>
      hasSourceRange(fnPath.node)
        ? code.slice(fnPath.node.start, fnPath.node.end)
        : ""
    );

    if (hexNameCount > 20) {
      features.push(`hex-names:${hexNameCount}`);
    }

    const prologueBody = [
      ...arraySlices,
      ...rotateSlices,
      ...decoderSlices,
    ].join("\n");

    const preludeDecls = collectPreludeDecls(
      ast.program.body,
      code,
      prologueBody
    );

    return {
      family: "obfuscator-io",
      confidence: 0.9,
      obfuscatorIO: {
        decoderNames,
        stringArrayNames: [...stringArrayNames],
        prologueSource: [
          ...preludeDecls,
          ...arraySlices,
          ...rotateSlices,
          ...decoderSlices,
        ].join("\n"),
        rotateCount: rotateIIFENodes.length,
      },
      features,
    };
  }

  // ---------- 压缩/普通 ----------
  const lines = code.split("\n");
  const avgLen = code.length / Math.max(1, lines.length);

  if (hexNameCount > 20) {
    features.push(`hex-names:${hexNameCount}`);

    return { family: "obfuscator-io", confidence: 0.5, features };
  }

  if (avgLen > 400) {
    features.push(`avg-line-len:${Math.round(avgLen)}`);

    return { family: "minified", confidence: 0.7, features };
  }

  return { family: "plain", confidence: 0.5, features };
};
