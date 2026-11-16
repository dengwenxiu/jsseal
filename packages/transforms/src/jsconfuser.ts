/**
 * JsConfuser 还原（状态机 CFF + xor 字符串解密）：
 *
 * 结构特征（__p_ 前缀签名）：
 *   - `__p_*_cff_hash(int)`：Knuth 黄金分割整数哈希（纯函数，可静态求值）
 *   - `__p_*_strings`：单一打包密文串
 *   - `__p_*_cff_xor(key, start, length)`：按 %95 可打印域异或解密（纯函数）
 *   - `__p_*_cff_sequence`：数值状态序列 + `__p_*_cff_slice(min,max)` 切片
 *   - 业务函数体被改写为 `while(sum(states)!==终值){switch(sum(states)){case N:...}}`
 *     状态数组每个 case 内做 8 路加法扰动（不透明谓词）
 *
 * 策略（纯静态 + 锚库验证）：
 *   1. cff-sequence 数组冻结为字面量（states 切片可静态求值）
 *   2. xor 解密调用：hash(依赖 states[i]+offset) 可静态求出 → xor 结果字面量回填
 *   3. 状态机：switch(sum(states)) 分发 → 数组元素全部已知 → sum 常量 →
 *      case 匹配唯一 → 按 while 循环模拟重排（依赖 fold-constants 先清不透明谓词）
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse, parseCode } from "@jsseal/ast";
import { runSealed } from "@jsseal/runtime";
import type { SealedOutput } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform } from "./types";

interface JsConfuserPlan {
  hashFn: string;
  xorFn: string;
  sumFn: string;
  sliceFn: string;
  sequenceVar: string;
  stringsVar: string;
  prologueSource: string;
}

/** 劫持驱动记录的 xor 调用事实（key 不参与静态匹配，故不保留） */
interface XorCapture {
  start: number;
  length: number;
  v: string;
}

/** 节点源码范围；babel 的 start/end 在缺省位置时为 null/undefined */
interface NodeSpan {
  start: number;
  end: number;
}

/** 可按 (start,length) 回填的 xor 调用点 */
interface XorSite {
  path: NodePath<t.CallExpression>;
  v: string;
}

/** 分组结果：一致键的回填表 + 歧义组数量 */
interface XorValueSelection {
  usable: Map<string, string>;
  ambiguous: number;
}

const spanOf = (node: t.Node): NodeSpan | null => {
  const { start, end } = node;

  if (start === null || start === undefined) {
    return null;
  }

  if (end === null || end === undefined) {
    return null;
  }

  return { start, end };
};

/** 字面量数字（含一元负号） → number；非字面量 → null */
const literalNumberOf = (node: t.Node | null | undefined): number | null => {
  if (t.isNumericLiteral(node)) {
    return node.value;
  }

  if (
    t.isUnaryExpression(node, { operator: "-" }) &&
    t.isNumericLiteral(node.argument)
  ) {
    return -node.argument.value;
  }

  return null;
};

/** 劫持记录条目校验：驱动侧写入的是 JSON，编译期无类型 */
const isXorCapture = (value: unknown): value is XorCapture => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("start" in value) || typeof value.start !== "number") {
    return false;
  }

  if (!("length" in value) || typeof value.length !== "number") {
    return false;
  }

  return "v" in value && typeof value.v === "string";
};

/** 解析 __calls dump：非法条目丢弃（返回空数组表示无可采信事实） */
const parseCaptures = (ret: string | undefined): XorCapture[] => {
  const decoded: unknown = JSON.parse(ret ?? "[]");
  const list: unknown[] = Array.isArray(decoded) ? decoded : [];

  return list.filter(isXorCapture);
};

const isFaulted = (out: SealedOutput): boolean =>
  out.flags.tapeExhausted === true ||
  out.flags.timeout === true ||
  out.flags.oom === true;

/** 按 (start, length) 字面量对分组；组内是同一调用点观测到的全部返回值 */
const groupXorCaptures = (captured: XorCapture[]): Map<string, Set<string>> => {
  const groups = new Map<string, Set<string>>();

  for (const entry of captured) {
    const groupKey = `${entry.start}|${entry.length}`;
    const observed = groups.get(groupKey) ?? new Set<string>();

    observed.add(entry.v);
    groups.set(groupKey, observed);
  }

  return groups;
};

/** 一致键才可回填：组内出现多个候选值 → 歧义组整组放弃 */
const pickConsistentValues = (
  groups: Map<string, Set<string>>
): XorValueSelection => {
  const usable = new Map<string, string>();
  let ambiguous = 0;

  for (const [groupKey, observed] of groups) {
    if (observed.size === 1) {
      const [only] = observed;

      usable.set(groupKey, only);
    } else {
      ambiguous += 1;
    }
  }

  return { usable, ambiguous };
};

/**
 * 调用形态：xor(key 表达式, start, length)。key 非字面量不可静态匹配，
 * 按 (start, length) 字面量对查表回填。**禁止**按出现顺序对应：执行序 ≠
 * AST 遍历序（js-confuser 2.1.3 的 xor 调用是 scope 计算键，顺序错位曾把
 * 回填变错填，被锚库击落）。
 */
const collectXorSites = (
  ast: t.File,
  xorFnName: string,
  usable: Map<string, string>
): XorSite[] => {
  const sites: XorSite[] = [];

  const visitXorCall = (path: NodePath<t.CallExpression>): void => {
    const { callee, arguments: args } = path.node;

    if (!t.isIdentifier(callee) || callee.name !== xorFnName) {
      return;
    }

    if (args.length !== 3) {
      return;
    }

    const start = literalNumberOf(args[1]);
    const length = literalNumberOf(args[2]);

    if (start === null || length === null) {
      return;
    }

    const v = usable.get(`${start}|${length}`);

    if (v === undefined) {
      return;
    }

    sites.push({ path, v });
  };

  traverse(ast, { CallExpression: visitXorCall });

  return sites;
};

/** 检测 JsConfuser 状态机特征并提取执行前置（含解密函数与数据） */
export const detectJsConfuser = (code: string): JsConfuserPlan | null => {
  /* 签名正则的命中结果决定后续切片范围——改写字面量本体（`u` 标志会改变转义
   * 与字符类语义、命名分组会改变组号含义）即改变判定，属行为恒等红线内禁改项 */
  /* oxlint-disable eslint/require-unicode-regexp, eslint/prefer-named-capture-group -- 见上：正则本体是签名判定的组成部分 */
  const hashFn = /function\s+(__p_\w+_cff_hash)\s*\(/.exec(code)?.[1];
  const xorFn = /function\s+(__p_\w+_cff_xor)\s*\(/.exec(code)?.[1];
  const sumFn = /function\s+(__p_\w+_cff_sum)\s*\(/.exec(code)?.[1];
  const sliceFn = /function\s+(__p_\w+_cff_slice)\s*\(/.exec(code)?.[1];

  if (
    hashFn === undefined ||
    xorFn === undefined ||
    sumFn === undefined ||
    sliceFn === undefined
  ) {
    return null;
  }

  const seqMatch = /var\s+(__p_\w+_cff_sequence)\s*=/.exec(code);
  const strMatch = /(__p_\w+_strings)\s*=/.exec(code);

  /* oxlint-enable eslint/require-unicode-regexp, eslint/prefer-named-capture-group */

  if (seqMatch === null || strMatch === null) {
    return null;
  }

  // prologue = 四个函数 + 两个数据变量的完整声明（按源码切片）
  const slices: string[] = [];
  const ast = parseCode(code);

  const names = new Set([
    hashFn,
    xorFn,
    sumFn,
    sliceFn,
    seqMatch[1],
    strMatch[1],
  ]);

  traverse(ast, {
    "FunctionDeclaration|VariableDeclaration": (path) => {
      const { node } = path;
      const span = spanOf(node);

      if (span === null) {
        return;
      }

      if (t.isFunctionDeclaration(node)) {
        if (node.id && names.has(node.id.name)) {
          slices.push(code.slice(span.start, span.end));
        }

        return;
      }

      if (t.isVariableDeclaration(node)) {
        for (const decl of node.declarations) {
          if (t.isIdentifier(decl.id) && names.has(decl.id.name)) {
            slices.push(code.slice(span.start, span.end));

            return;
          }
        }
      }
    },
  });

  /* strings 变量与 sequence 同一 VariableDeclaration（var a=..., b=...）→ 单次切片覆盖两个；
   * 故有效阈值是 5 */
  if (slices.length < 5) {
    return null;
  }

  return {
    hashFn,
    xorFn,
    sumFn,
    sliceFn,
    sequenceVar: seqMatch[1],
    stringsVar: strMatch[1],
    prologueSource: slices.join("\n"),
  };
};

export const jsconfuserUnfold: Transform = {
  name: "jsconfuser-unfold",
  risk: "unsafe",
  async run(ast, ctx) {
    const plan = detectJsConfuser(ctx.code);

    if (plan === null) {
      return result(false, ["not jsconfuser"]);
    }

    const samples = ctx.corpus?.samples ?? [];

    if (samples.length === 0) {
      return result(false, ["no corpus"]);
    }

    const [sample] = samples;

    // ---------- 1) 在封闭运行时求值 states 终态与全部 xor 解密 ----------
    // 业务函数把 sequence 切片+魔数混入 states 数组传给 sum；
    // 直接执行整个程序一次，通过 trace 捕获 sum/xor 的实际入参-返回对，
    // 再静态回填（此处先做字符串解密——每个 xor(key,start,len) 调用点求值回填）
    const evalDriver = `
var __calls = [];
var __origXor = globalThis[${JSON.stringify(plan.xorFn)}];
globalThis[${JSON.stringify(plan.xorFn)}] = function (key, start, length) {
  var v = __origXor(key, start, length);
  __calls.push({ key: key, start: start, length: length, v: v });
  return v;
};
`;

    // 求值环境：prologue + 劫持 + 完整业务代码（一次执行捕获全部 xor 调用）
    const program = `${plan.prologueSource}\n${evalDriver}\n${ctx.code}\n`;
    const { tapes } = sample;
    let out;

    try {
      out = await runSealed({
        tapes,
        code: program,
        mode: "replay",
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch (error) {
      return result(false, [
        `probe fault: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }

    if (isFaulted(out)) {
      return result(false, [`probe fault: ${JSON.stringify(out.flags)}`]);
    }

    // 从 dump 拿捕获的 xor 调用（劫持函数存到 __jsseal）
    const captureDriver = `globalThis.__jsseal_ret_raw = JSON.stringify(__calls);`;
    let captured: XorCapture[];

    try {
      const captureOut = await runSealed({
        tapes,
        code: `${program}${captureDriver}`,
        mode: "replay",
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });

      captured = parseCaptures(captureOut.ret);
    } catch {
      return result(false, ["capture fault"]);
    }

    if (captured.length === 0) {
      return result(false, ["no xor calls captured"]);
    }

    // ---------- 2) xor 调用点静态匹配回填 ----------
    const groups = groupXorCaptures(captured);
    const { usable, ambiguous } = pickConsistentValues(groups);
    const jobs = collectXorSites(ast, plan.xorFn, usable);
    let replacedXor = 0;

    for (const { path, v } of jobs) {
      try {
        path.replaceWith(t.stringLiteral(v));
        replacedXor += 1;
      } catch {
        /* skip */
      }
    }

    if (replacedXor === 0) {
      return result(false, [
        `xor sites not matched (groups=${groups.size} ambiguous=${ambiguous})`,
      ]);
    }

    const notes = [
      `xor-inlined=${replacedXor}/${captured.length}`,
      `groups=${groups.size}`,
    ];

    if (ambiguous > 0) {
      notes.push(`ambiguous=${ambiguous}`);
    }

    return result(true, notes);
  },
};
