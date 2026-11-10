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

import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import type { BackendKind } from '@jsseal/runtime';
import { result, type Transform } from './types';
import type { NodePath } from '@babel/traverse';

const CHARSET_RE = /^[\[\]()!+/]+$/;
/** 小于此长度的切片不值得一轮求值（[]、![]、+[] 等平凡原子） */
const MIN_LEN = 4;
/** 一次变换内的折叠迭代上限（失败极大子树下钻用） */
const MAX_ITER = 4;
/** memo 容量上限（防长会话膨胀；超限清空后按需重算） */
const MEMO_CAP = 100_000;

interface FoldValue {
  s: 'string' | 'number' | 'boolean';
  v: string | number | boolean;
}

/** 源文本 → 求值结果（null = 失败/非原始值） */
const memo = new Map<string, FoldValue | null>();

function isFoldRoot(node: t.Node): node is t.Expression {
  if (!t.isExpression(node)) return false;
  // 调用根禁求值：外层 payload 执行 + 任何潜在副作用的构造调用
  if (t.isCallExpression(node) || t.isNewExpression(node)) return false;
  return true;
}

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
function collectMaximal(ast: t.File, code: string): Candidate[] {
  const out: Candidate[] = [];
  traverse(ast, {
    enter(path) {
      const n = path.node;
      if (!isFoldRoot(n) || n.start == null || n.end == null) return;
      const text = code.slice(n.start, n.end);
      if (text.length < MIN_LEN || !CHARSET_RE.test(text)) return;
      out.push({ path, text, start: n.start, end: n.end });
      const cached = memo.get(text);
      if (cached === undefined || cached !== null) {
        // 未知或已知成功：不再下钻（成功的根整棵替换即可）
        path.skip();
      }
      // 已知失败：继续下钻收集子候选
    },
  });
  return out;
}

/** 批量求值新文本（一次封闭运行）；结果写回 memo */
interface EvalCtx {
  backend: BackendKind;
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

async function evalTexts(texts: string[], ctx: EvalCtx): Promise<number> {
  const todo = [...new Set(texts)].filter((x) => !memo.has(x));
  if (todo.length === 0) return 0;
  if (memo.size > MEMO_CAP) memo.clear();
  for (const x of todo) memo.set(x, null); // 悲观默认：求值失败
  // 每条独立 try——单条抛错（如深层栈溢出）不影响其余
  const lines = todo.map((x, i) => `try{__r[${i}]=__f((${x}))}catch(e){}`);
  // 结果走 __jsseal_ret_raw 通道（完成值通道会经 canon 二次编码）
  const snippet =
    'var __f=function(x){return {v:x,s:typeof x}};var __r=[];\n' +
    lines.join('\n') +
    '\nglobalThis.__jsseal_ret_raw = JSON.stringify(__r);';
  let out;
  try {
    out = await runSealed({
      code: snippet,
      mode: 'record',
      backend: ctx.backend,
      timeoutMs: ctx.timeoutMs,
      memoryLimitBytes: ctx.memoryLimitBytes,
    });
  } catch {
    return todo.length;
  }
  if (!out.ok || out.flags.timeout || out.flags.oom) return todo.length;
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.ret ?? 'null');
  } catch {
    return todo.length;
  }
  if (!Array.isArray(parsed) || parsed.length !== todo.length) return todo.length;
  parsed.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return; // 保持失败
    const { s, v } = entry as { s?: unknown; v?: unknown };
    if (s === 'string' && typeof v === 'string') memo.set(todo[i], { s, v });
    else if (s === 'number' && typeof v === 'number' && Number.isFinite(v)) memo.set(todo[i], { s, v });
    else if (s === 'boolean' && typeof v === 'boolean') memo.set(todo[i], { s, v });
  });
  return todo.length;
}

function literalOf(fv: FoldValue): t.Expression | null {
  if (fv.s === 'string') return t.stringLiteral(fv.v as string);
  if (fv.s === 'boolean') return t.booleanLiteral(fv.v as boolean);
  if (fv.s === 'number') {
    return t.numericLiteral(fv.v as number);
  }
  return null;
}

export const foldJsfuck: Transform = {
  name: 'fold-jsfuck',
  risk: 'unsafe',
  async run(ast, ctx) {
    // 便宜门卫：普通代码不会出现 10+ 连续 charset 字符
    if (!/[\[\]()!+/]{10,}/.test(ctx.code)) return result(false, ['no charset atoms']);

    let replacedTotal = 0;
    let evaluated = 0;
    let failed = 0;

    for (let iter = 0; iter < MAX_ITER; iter++) {
      const cands = collectMaximal(ast, ctx.code);
      if (cands.length === 0) break;
      evaluated += await evalTexts(
        cands.map((c) => c.text),
        ctx,
      );

      // 只替换有值的候选；从最外层开始，嵌套在其内的跳过（整棵替换已覆盖）
      const winners = cands
        .filter((c) => {
          const m = memo.get(c.text);
          if (m === undefined || m === null) {
            return false;
          }
          return true;
        })
        .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
      let replaced = 0;
      let lastEnd = -1;
      for (const c of winners) {
        if (c.start < lastEnd) continue; // 嵌套在已替换范围内
        const lit = literalOf(memo.get(c.text) as FoldValue);
        if (!lit) continue;
        try {
          c.path.replaceWith(lit);
          replaced++;
          lastEnd = c.end;
        } catch {
          /* skip */
        }
      }
      replacedTotal += replaced;
      failed = [...memo.values()].filter((v) => v === null).length;
      if (replaced === 0) break;
    }

    if (replacedTotal === 0) {
      return result(false, ['no foldable atoms']);
    }
    const notes = [`folded=${replacedTotal}`, `evaluated=${evaluated}`];
    if (failed > 0) notes.push(`failed=${failed}`);
    return result(true, notes);
  },
};
