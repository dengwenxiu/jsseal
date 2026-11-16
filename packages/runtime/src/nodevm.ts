/**
 * node:vm 备用后端（开发/调试用；非安全边界，生产使用 quickjs 后端）。
 * prelude 与 quickjs 后端完全一致，保证行为对齐（引擎差异除外——
 * 锚库比较必须固定在同一后端内进行）。
 */

import * as vm from "node:vm";

import { CAPTURE_TAIL, DUMP_EXPR } from "./prelude";
import type { RawRunOutcome } from "./quickjs";
import type { GuestProgram, SealedOutput } from "./types";

/**
 * 执行一段本包自造的注入源码（prelude/尾巴），不需要返回值。
 * context 已禁用 wasm 代码生成；时间预算只施加在用户代码段。
 */
const evalSnippet = (
  context: vm.Context,
  code: string,
  filename: string
): void => {
  // oxlint-disable-next-line sonarjs/code-eval -- node:vm 后端的存在意义即执行封闭程序文本，注入源码全部由本包组装
  vm.runInContext(code, context, { filename });
};

/** dump 表达式求值 → JSON 文本（DUMP_EXPR 恒为 JSON.stringify(...)） */
const evalDumpJson = (context: vm.Context): string => {
  // oxlint-disable-next-line sonarjs/code-eval -- 同上：求值的是本包常量表达式 DUMP_EXPR
  const json: unknown = vm.runInContext(DUMP_EXPR, context, {
    filename: "jsseal-dump.js",
  });

  // SAFETY: DUMP_EXPR 是 JSON.stringify(globalThis.__jsseal.dump())，返回值恒为字符串
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vm 求值结果无静态类型（unknown），此处收紧到 JSON 文本
  return json as string;
};

/**
 * 执行用户代码段：完成值/异常写入 prelude 预定义的非枚举通道
 * （__jsseal_last/__jsseal_err），与 quickjs 后端的 setProp 通道同构。
 */
const runUserCode = (context: vm.Context, prog: GuestProgram): void => {
  let completion: unknown;
  let threw: unknown;

  try {
    // oxlint-disable-next-line sonarjs/code-eval -- 需要的就是执行待分析的封闭程序文本（timeout 由 vm 保证）
    completion = vm.runInContext(prog.code, context, {
      filename: "input.js",
      timeout: prog.timeoutMs,
    });
  } catch (error) {
    threw = error;
  }

  context.__jsseal_last = threw === undefined ? completion : undefined;
  context.__jsseal_err = threw;
};

export const runNodeVm = (prog: GuestProgram): RawRunOutcome => {
  const context = vm.createContext(
    {},
    { codeGeneration: { strings: true, wasm: false } }
  );

  try {
    evalSnippet(context, prog.prelude, "jsseal-prelude.js");
    runUserCode(context, prog);

    try {
      evalSnippet(context, CAPTURE_TAIL, "jsseal-capture.js");
    } catch {
      /* ignore */
    }

    const json = evalDumpJson(context);
    // SAFETY: json 由本包 prelude 注入的 __jsseal.dump() 唯一产出，形状即 SealedOutput
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 跨 I/O 边界断言：产出方是本包 prelude，形状受控
    const output = JSON.parse(json) as SealedOutput;

    output.console ??= [];
    output.storage ??= {};
    output.consumed ??= { random: 0, date: 0, time: 0, crypto: 0 };
    output.tapes ??= { random: [], date: [], time: [], crypto: [] };
    output.flags ??= {};
    const thrown = output.thrown ?? "";

    if (
      output.flags.tapeExhausted === true ||
      thrown.includes("__JSSEAL_TAPE_EXHAUSTED__")
    ) {
      output.flags.tapeExhausted = true;
    }

    if (thrown.includes("Script execution timed out")) {
      output.flags.timeout = true;
    }

    return { output };
  } catch (error) {
    return { fault: "dump-error", detail: String(error) };
  }
};
