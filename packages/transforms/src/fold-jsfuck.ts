/**
 * JSFuck 全编码折叠：
 *
 * 字符集 `[]()!+/` 的表达式子树**不可能**包含标识符/赋值/属性写/模板——
 * 它在语法层面就是纯函数（数组/字符串/数字字面量 + 成员读取 + 一元二元运算，
 * `/` 仅作除法；正则字面量误入候选会被"只回填原始值"过滤——RegExp 是对象），
 * 因此可以在封闭运行时安全求值并回填为原始字面量。
 * （`/` 用于覆盖用除法构造小数点的一类变体：`+!+[]/(+!+[]+[+!+[]])` = 1/11）
 *
 * 这是"环境封闭 → 条件纯函数"方法论的最纯案例：不需要 prologue、不消耗种子，
 * 求值结果只依赖语言本身。
 *
 * 规则：
 * - 候选 = 源码切片仅含 [\[\]()!+/] 的表达式节点（用原始偏移切片，零打印开销）
 * - Call/New 根**禁止**求值——最外层 payload 执行调用必须留给
 *   unfold-ctor-chain（在这里求值会执行 payload：既是副作用风险，
 *   也可能把"执行了 payload 的返回值"当成折叠结果，恒等性必被锚库击落）
 * - 只回填原始值（string / 有限 number / boolean）；函数/数组/正则结果跳过
 *   （如 []["fill"] 求值为函数——保持原样，后续形态识别需要它）
 * - 求值结果按源文本 memo：确定性保证同一文本必得同一值，跨轮/跨样本安全
 * - 折叠产物链：fold-jsfuck 产出字符串字面量 → fold-constants 拼接 →
 *   unfold-ctor-chain 形态 A 内联 payload
 */

import type { NodePath } from "@babel/traverse";
import * as t from "@babel/types";
import { traverse } from "@jsseal/ast";
import { runSealed } from "@jsseal/runtime";
import type { BackendKind } from "@jsseal/runtime";

import { result } from "./types";
import type { Transform } from "./types";

// oxlint-disable-next-line eslint/require-unicode-regexp -- u 模式下 \! 不是合法 IdentityEscape（SyntaxError），改正则本体属语义红线
const CHARSET_RE = /^[[\]()!+/]+$/;

/** 小于此长度的切片不值得一轮求值（[]、![]、+[] 等平凡原子） */
const MIN_LEN = 4;

/** 一次变换内的折叠迭代上限（失败极大子树下钻用） */
const MAX_ITER = 4;

/** memo 容量上限（防长会话膨胀；超限清空后按需重算） */
const MEMO_CAP = 100_000;

/** 求值结果：只收原始值形态（函数/数组/正则结果保持原样） */
type FoldValue =
  | { s: "string"; v: string }
  | { s: "number"; v: number }
  | { s: "boolean"; v: boolean };

/** 源文本 → 求值结果（null = 失败/非原始值） */
const memo = new Map<string, FoldValue | null>();

/** 封闭运行时的求值条目（snippet 内 __f 返回 \{ v: x, s: typeof x \}） */
interface EvalEntry {
  s?: unknown;
  v?: unknown;
}

/** 条目形状判定：JSON.parse 的产物是任意值，形状只能运行时判定 */
const isEvalEntry = (v: unknown): v is EvalEntry =>
  typeof v === "object" && v !== null;

const isString = (v: unknown): v is string => typeof v === "string";

const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

const isFoldRoot = (node: t.Node): node is t.Expression => {
  if (!t.isExpression(node)) {
    return false;
  }

  // 调用根禁求值：外层 payload 执行 + 任何潜在副作用的构造调用
  if (t.isCallExpression(node) || t.isNewExpression(node)) {
    return false;
  }

  return true;
};

/** 节点在源码中的偏移；babel 允许 null/undefined，缺失则视为不可切片 */
const sourceSpanOf = (n: t.Node): { start: number; end: number } | null => {
  const { start, end } = n;

  if (start === null || start === undefined) {
    return null;
  }

  if (end === null || end === undefined) {
    return null;
  }

  return { start, end };
};

/** 条目 → 折叠值；非原始值返回 null（保持原样） */
const foldValueOf = (entry: EvalEntry): FoldValue | null => {
  if (entry.s === "string" && isString(entry.v)) {
    return { s: "string", v: entry.v };
  }

  if (entry.s === "number" && isFiniteNumber(entry.v)) {
    return { s: "number", v: entry.v };
  }

  if (entry.s === "boolean" && isBoolean(entry.v)) {
    return { s: "boolean", v: entry.v };
  }

  return null;
};

/** 折叠值 → 字面量节点；无值返回 null */
const literalOf = (fv: FoldValue | null): t.Expression | null => {
  if (fv === null) {
    return null;
  }

  if (fv.s === "string") {
    return t.stringLiteral(fv.v);
  }

  if (fv.s === "boolean") {
    return t.booleanLiteral(fv.v);
  }

  if (fv.s === "number") {
    return t.numericLiteral(fv.v);
  }

  return null;
};

interface Candidate {
  path: NodePath;
  text: string;
  start: number;
  end: number;
}

/**
 * 收集极大 charset 候选。memo 中已知失败的根会下钻（其子树里可能有
 * 可折叠的兄弟分支——典型：A+B 整体求值超深失败，但 A 单独可折叠）。
 */
const collectMaximal = (ast: t.File, code: string): Candidate[] => {
  const out: Candidate[] = [];

  traverse(ast, {
    enter(path) {
      const n = path.node;
      const span = sourceSpanOf(n);

      if (!isFoldRoot(n) || span === null) {
        return;
      }

      const text = code.slice(span.start, span.end);

      if (text.length < MIN_LEN || !CHARSET_RE.test(text)) {
        return;
      }

      out.push({ path, text, start: span.start, end: span.end });

      const cached = memo.get(text);

      // 未知或已知成功：不再下钻（成功的根整棵替换即可）
      if (cached === undefined || cached !== null) {
        path.skip();
      }

      // 已知失败：继续下钻收集子候选
    },
  });

  return out;
};

/** 批量求值新文本（一次封闭运行）；结果写回 memo */
interface EvalCtx {
  backend: BackendKind;
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

const evalTexts = async (texts: string[], ctx: EvalCtx): Promise<number> => {
  const todo = [...new Set(texts)].filter((x) => !memo.has(x));

  if (todo.length === 0) {
    return 0;
  }

  if (memo.size > MEMO_CAP) {
    memo.clear();
  }

  // 悲观默认：求值失败
  for (const x of todo) {
    memo.set(x, null);
  }

  // 每条独立 try——单条抛错（如深层栈溢出）不影响其余
  const lines = todo.map((x, i) => `try{__r[${i}]=__f((${x}))}catch(e){}`);

  // 结果走 __jsseal_ret_raw 通道（完成值通道会经 canon 二次编码）
  const snippet = `var __f=function(x){return {v:x,s:typeof x}};var __r=[];\n${lines.join(
    "\n"
  )}\nglobalThis.__jsseal_ret_raw = JSON.stringify(__r);`;

  let out;

  try {
    out = await runSealed({
      code: snippet,
      mode: "record",
      backend: ctx.backend,
      timeoutMs: ctx.timeoutMs,
      memoryLimitBytes: ctx.memoryLimitBytes,
    });
  } catch {
    return todo.length;
  }

  if (!out.ok || out.flags.timeout === true || out.flags.oom === true) {
    return todo.length;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(out.ret ?? "null");
  } catch {
    return todo.length;
  }

  if (!Array.isArray(parsed) || parsed.length !== todo.length) {
    return todo.length;
  }

  for (const [i, entry] of parsed.entries()) {
    if (!isEvalEntry(entry)) {
      continue;
    }

    const fv = foldValueOf(entry);

    if (fv !== null) {
      memo.set(todo[i], fv);
    }
  }

  return todo.length;
};

export const foldJsfuck: Transform = {
  name: "fold-jsfuck",
  risk: "unsafe",
  async run(ast, ctx) {
    // 便宜门卫：普通代码不会出现 10+ 连续 charset 字符
    // oxlint-disable-next-line eslint/require-unicode-regexp -- 同 CHARSET_RE：\! 在 u 模式下非法，改字符集属语义红线
    if (!/[[\]()!+/]{10,}/.test(ctx.code)) {
      return result(false, ["no charset atoms"]);
    }

    let replacedTotal = 0;
    let evaluated = 0;
    let failed = 0;

    for (let iter = 0; iter < MAX_ITER; iter += 1) {
      const cands = collectMaximal(ast, ctx.code);

      // oxlint-disable-next-line eslint/no-await-in-loop -- 每轮求值依赖上一轮写回的 memo 去重结果，必须串行
      evaluated += await evalTexts(
        cands.map((c) => c.text),
        ctx
      );

      // 只替换有值的候选；从最外层开始，嵌套在其内的跳过（整棵替换已覆盖）
      const winners = cands
        .filter((c) => (memo.get(c.text) ?? null) !== null)
        // oxlint-disable-next-line unicorn/no-array-sort -- lib 为 ES2022（toSorted 在 ES2023，tsc 报错）；此处排序的是本地新建数组，无共享副作用
        .sort(
          (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start)
        );

      let replaced = 0;
      let lastEnd = -1;

      for (const c of winners) {
        // 嵌套在已替换范围内
        if (c.start >= lastEnd) {
          const lit = literalOf(memo.get(c.text) ?? null);

          if (lit !== null) {
            try {
              c.path.replaceWith(lit);
              replaced += 1;
              lastEnd = c.end;
            } catch {
              /* skip */
            }
          }
        }
      }

      replacedTotal += replaced;
      failed = [...memo.values()].filter((v) => v === null).length;

      if (replaced === 0) {
        break;
      }
    }

    if (replacedTotal === 0) {
      return result(false, ["no foldable atoms"]);
    }

    const notes = [`folded=${replacedTotal}`, `evaluated=${evaluated}`];

    if (failed > 0) {
      notes.push(`failed=${failed}`);
    }

    return result(true, notes);
  },
};
