/**
 * QuickJS 后端（主力）：quickjs-emscripten（wasm，无 native 依赖，线性内存硬隔离）。
 *
 * 执行序列：
 *   prelude → 用户代码(+入口尾巴) → 微任务清空 → 完成值捕获 → dump JSON
 *
 * 注意：quickjs-emscripten 句柄所有权——evalCode/setProp 的句柄必须显式 dispose，
 * 否则 runtime.dispose() 触发 gc_obj_list 断言。
 */

import { getQuickJS } from "quickjs-emscripten";
import type { QuickJSContext, QuickJSWASMModule } from "quickjs-emscripten";

import { CAPTURE_TAIL, DUMP_EXPR } from "./prelude";
import type { GuestProgram, SealedOutput } from "./types";

let modulePromise: Promise<QuickJSWASMModule> | null = null;

const getModule = async (): Promise<QuickJSWASMModule> => {
  modulePromise ??= getQuickJS();

  return await modulePromise;
};

export interface RawRunOutcome {
  output?: SealedOutput;
  // oxlint-disable-next-line sonarjs/max-union-size -- 故障分类与锚库/CLI 的 fault 字段一一对应，拆成别名只会分散定义
  fault?: "timeout" | "oom" | "prelude-error" | "dump-error";
  detail?: string;
}

/** dump JSON → SealedOutput（两个 native 系后端共用） */
export const parseDump = (json: string): SealedOutput => {
  // SAFETY: json 由本包 prelude 注入的 __jsseal.dump() 唯一产出，形状即 SealedOutput
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 跨 I/O 边界断言：产出方是本包 prelude，形状受控
  const o = JSON.parse(json) as SealedOutput;
  o.console ??= [];
  o.storage ??= {};
  o.consumed ??= { random: 0, date: 0, time: 0, crypto: 0 };
  o.tapes ??= { random: [], date: [], time: [], crypto: [] };
  o.flags ??= {};
  o.envMisses ??= {};
  o.netLog ??= [];
  o.netMisses ??= [];
  o.evalLog ??= [];

  return o;
};

/** 哨兵标志识别（超时/内存/磁带越界），两个后端共用 */
export const applyFlagDetection = (output: SealedOutput): SealedOutput => {
  const thrown = output.thrown ?? "";

  if (
    output.flags.tapeExhausted === true ||
    thrown.includes("__JSSEAL_TAPE_EXHAUSTED__")
  ) {
    output.flags.tapeExhausted = true;
  }

  if (thrown.includes("InterruptError") || thrown.includes("interrupted")) {
    output.flags.timeout = true;
  }

  if (thrown.includes("OutOfMemory") || thrown.includes("out of memory")) {
    output.flags.oom = true;
  }

  return output;
};

/** eval 一段辅助代码（忽略返回值），返回错误文本或 null */
const evalAux = (
  ctx: QuickJSContext,
  code: string,
  filename: string
): string | null => {
  const r = ctx.evalCode(code, filename);

  if (r.error !== undefined) {
    const d = JSON.stringify(ctx.dump(r.error));
    r.error.dispose();

    return d;
  }

  ctx.unwrapResult(r).dispose();

  return null;
};

/** 驱动一步虚拟定时器；返回是否还有到期任务（false = 事件循环已空） */
const runNextTimer = (ctx: QuickJSContext): boolean => {
  const r = ctx.evalCode(
    "String(globalThis.__jsseal && globalThis.__jsseal.runNextTimer ? globalThis.__jsseal.runNextTimer() : false)",
    "jsseal-timers.js"
  );

  if (r.error !== undefined) {
    r.error.dispose();

    return false;
  }

  const h = ctx.unwrapResult(r);
  const more = ctx.getString(h);
  h.dispose();

  return more === "true";
};

export const runQuickJS = async (
  prog: GuestProgram
): Promise<RawRunOutcome> => {
  const mod = await getModule();
  const ctx = mod.newContext();

  try {
    ctx.runtime.setMemoryLimit(prog.memoryLimitBytes);
    // 注意：不设置 setMaxStackSize——wasm 构建的栈上限远小于 native，
    // 显式设置过大的栈会导致 eval 直接失败（已实测）
    const deadline = Date.now() + prog.timeoutMs;
    ctx.runtime.setInterruptHandler(() => Date.now() > deadline);

    // 1) prelude
    const preludeErr = evalAux(ctx, prog.prelude, "jsseal-prelude.js");

    if (preludeErr !== null) {
      return {
        fault: "prelude-error",
        detail: `prelude failed: ${preludeErr}`,
      };
    }

    // 2) 用户代码（program 级，保持顶层作用域）；完成值/异常挂到全局
    {
      const r = ctx.evalCode(prog.code, "input.js");

      if (r.error) {
        ctx.setProp(ctx.global, "__jsseal_err", r.error);
        r.error.dispose();
      } else {
        const h = ctx.unwrapResult(r);
        ctx.setProp(ctx.global, "__jsseal_last", h);
        h.dispose();
      }
    }

    // 3) 虚拟事件循环：微任务 → 到期定时器交替驱动（确定性，步数上限哨兵）
    const MAX_TIMER_STEPS = 100_000;
    let timerSteps = 0;
    let hasMoreTimers = true;

    while (timerSteps < MAX_TIMER_STEPS && hasMoreTimers) {
      try {
        ctx.runtime.executePendingJobs();
      } catch {
        /* pending job 抛错不阻断 */
      }

      hasMoreTimers = runNextTimer(ctx);
      timerSteps += 1;
    }

    if (timerSteps >= MAX_TIMER_STEPS) {
      evalAux(
        ctx,
        "globalThis.__jsseal.flags.timerDropped = true",
        "jsseal-timer-flag.js"
      );
    }

    // 4) 完成值捕获
    evalAux(ctx, CAPTURE_TAIL, "jsseal-capture.js");

    // 5) dump
    const r3 = ctx.evalCode(DUMP_EXPR, "jsseal-dump.js");

    if (r3.error) {
      const d = JSON.stringify(ctx.dump(r3.error));
      r3.error.dispose();

      return { fault: "dump-error", detail: d };
    }

    const dumpHandle = ctx.unwrapResult(r3);
    const json = ctx.getString(dumpHandle);
    dumpHandle.dispose();

    return { output: applyFlagDetection(parseDump(json)) };
  } finally {
    ctx.dispose();
  }
};
