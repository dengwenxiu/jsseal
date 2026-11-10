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

import * as t from '@babel/types';
import { traverse, parseCode } from '@jsseal/ast';
import { runSealed } from '@jsseal/runtime';
import { result, type Transform } from './types';

interface JsConfuserPlan {
  hashFn: string;
  xorFn: string;
  sumFn: string;
  sliceFn: string;
  sequenceVar: string;
  stringsVar: string;
  prologueSource: string;
}

/** 检测 JsConfuser 状态机特征并提取执行前置（含解密函数与数据） */
export function detectJsConfuser(code: string): JsConfuserPlan | null {
  const hashFn = /function\s+(__p_\w+_cff_hash)\s*\(/.exec(code)?.[1];
  const xorFn = /function\s+(__p_\w+_cff_xor)\s*\(/.exec(code)?.[1];
  const sumFn = /function\s+(__p_\w+_cff_sum)\s*\(/.exec(code)?.[1];
  const sliceFn = /function\s+(__p_\w+_cff_slice)\s*\(/.exec(code)?.[1];
  if (!hashFn || !xorFn || !sumFn || !sliceFn) return null;
  const seqMatch = /var\s+(__p_\w+_cff_sequence)\s*=/.exec(code);
  const strMatch = /(__p_\w+_strings)\s*=/.exec(code);
  if (!seqMatch || !strMatch) return null;
  // prologue = 四个函数 + 两个数据变量的完整声明（按源码切片）
  const slices: string[] = [];
  const ast = parseCode(code);
  const names = new Set([hashFn, xorFn, sumFn, sliceFn, seqMatch[1], strMatch[1]]);
  traverse(ast, {
    'FunctionDeclaration|VariableDeclaration'(path) {
      const n = path.node as t.Node;
      if (t.isFunctionDeclaration(n) && n.id && names.has(n.id.name) && n.start != null && n.end != null) {
        slices.push(code.slice(n.start, n.end));
        return;
      }
      if (t.isVariableDeclaration(n)) {
        for (const d of n.declarations) {
          if (t.isIdentifier(d.id) && names.has(d.id.name) && n.start != null && n.end != null) {
            slices.push(code.slice(n.start, n.end));
            return;
          }
        }
      }
    },
  });
  /* strings 变量与 sequence 同一 VariableDeclaration（var a=..., b=...）→ 单次切片覆盖两个；
   * 故有效阈值是 5 */
  if (slices.length < 5) return null;
  return {
    hashFn,
    xorFn,
    sumFn,
    sliceFn,
    sequenceVar: seqMatch[1],
    stringsVar: strMatch[1],
    prologueSource: slices.join('\n'),
  };
}

export const jsconfuserUnfold: Transform = {
  name: 'jsconfuser-unfold',
  risk: 'unsafe',
  async run(ast, ctx) {
    const plan = detectJsConfuser(ctx.code);
    if (!plan) return result(false, ['not jsconfuser']);

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
    if (!ctx.corpus || ctx.corpus.samples.length === 0) return result(false, ['no corpus']);
    const sample = ctx.corpus.samples[0];
    let out;
    try {
      out = await runSealed({
        code: plan.prologueSource + '\n' + evalDriver + '\n' + ctx.code + '\n',
        mode: 'replay',
        tapes: sample.tapes,
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
    } catch (e) {
      return result(false, [`probe fault: ${(e as Error).message}`]);
    }
    if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) {
      return result(false, [`probe fault: ${JSON.stringify(out.flags)}`]);
    }
    // 从 dump 拿捕获的 xor 调用（劫持函数存到 __jsseal）
    const captureDriver = `globalThis.__jsseal_ret_raw = JSON.stringify(__calls);`;
    let captured: Array<{ key: number; start: number; length: number; v: string }>;
    try {
      const out2 = await runSealed({
        code: plan.prologueSource + '\n' + evalDriver + '\n' + ctx.code + '\n' + captureDriver,
        mode: 'replay',
        tapes: sample.tapes,
        backend: ctx.backend,
        timeoutMs: ctx.timeoutMs,
        memoryLimitBytes: ctx.memoryLimitBytes,
      });
      captured = JSON.parse(out2.ret ?? '[]');
    } catch {
      return result(false, ['capture fault']);
    }
    if (!Array.isArray(captured) || captured.length === 0) {
      return result(false, ['no xor calls captured']);
    }

    // ---------- 2) xor 调用点静态匹配回填 ----------
    // 调用形态：xor(<key 表达式>, start, length)。key 非字面量不可静态匹配，
    // 按 (start, length) 字面量对分组：组内全部 v 一致才回填（同组不同 key 可
    // 合法产出不同 v——歧义组整组放弃）。**禁止**按出现顺序对应：
    // 执行序 ≠ AST 遍历序（js-confuser 2.1.3 的 xor 调用是 scope 计算键，
    // 顺序错位曾把回填变错填，被锚库击落）。
    const groups = new Map<string, Set<string>>();
    for (const entry of captured) {
      if (typeof entry?.start !== 'number' || typeof entry?.length !== 'number' || typeof entry.v !== 'string') continue;
      const gk = `${entry.start}|${entry.length}`;
      const g = groups.get(gk) ?? new Set<string>();
      g.add(entry.v);
      groups.set(gk, g);
    }
    const usable = new Map<string, string>();
    let ambiguous = 0;
    for (const [gk, vs] of groups) {
      if (vs.size === 1) usable.set(gk, [...vs][0]);
      else ambiguous++;
    }

    let replacedXor = 0;
    const jobs: Array<{ path: import('@babel/traverse').NodePath<t.CallExpression>; v: string }> = [];
    traverse(ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee) || callee.name !== plan.xorFn) return;
        if (path.node.arguments.length !== 3) return;
        const a1 = path.node.arguments[1] as t.Expression;
        const a2 = path.node.arguments[2] as t.Expression;
        const start = t.isNumericLiteral(a1) ? a1.value : t.isUnaryExpression(a1, { operator: '-' }) && t.isNumericLiteral(a1.argument) ? -a1.argument.value : null;
        const len = t.isNumericLiteral(a2) ? a2.value : t.isUnaryExpression(a2, { operator: '-' }) && t.isNumericLiteral(a2.argument) ? -a2.argument.value : null;
        if (start === null || len === null) return;
        const v = usable.get(`${start}|${len}`);
        if (v === undefined) return;
        jobs.push({ path, v });
      },
    });
    for (const { path, v } of jobs) {
      try {
        path.replaceWith(t.stringLiteral(v));
        replacedXor++;
      } catch {
        /* skip */
      }
    }
    if (replacedXor === 0) {
      return result(false, [`xor sites not matched (groups=${groups.size} ambiguous=${ambiguous})`]);
    }

    const notes = [`xor-inlined=${replacedXor}/${captured.length}`, `groups=${groups.size}`];
    if (ambiguous > 0) notes.push(`ambiguous=${ambiguous}`);
    return result(true, notes);
  },
};
