/**
 * Native 后端（主力）：\@jsseal/engine-native（quickjs-ng fork，N-API）。
 *
 * 种子拦截双层结构：
 *  - random/date/time/crypto → 引擎级（C 拦截 xorshift64star / date_now / js_perf_now /
 *    原生 crypto 注入，guest 不可觉察，toString 天然 [native code]）
 *  - crypto → 引擎级（JS_AddSealCrypto：原生 getRandomValues/randomUUID + 独立 crypto 磁带）
 * 磁带与消费计数在宿主侧合并成统一 SealedOutput。
 */

import { runSealedNative } from "@jsseal/engine-native";
import type { NativeSealedRunResult } from "@jsseal/engine-native";

import { CAPTURE_TAIL, DUMP_EXPR } from "./prelude";
import { applyFlagDetection, parseDump } from "./quickjs";
import type { RawRunOutcome } from "./quickjs";
import type { GuestProgram, SealedOutput, TraceEvent } from "./types";

/** 合并引擎级磁带与消费计数（crypto 保留 prelude 层） */
const mergeEngineSeeds = (
  output: SealedOutput,
  res: NativeSealedRunResult
): void => {
  if (res.seedTapes !== undefined) {
    output.tapes.random = res.seedTapes.random;
    output.tapes.date = res.seedTapes.date;
    output.tapes.time = res.seedTapes.time;
    output.tapes.crypto = res.seedTapes.crypto ?? [];
  }

  if (res.seedConsumed !== undefined) {
    output.consumed.random = res.seedConsumed.random;
    output.consumed.date = res.seedConsumed.date;
    output.consumed.time = res.seedConsumed.time;
    output.consumed.crypto = res.seedConsumed.crypto ?? 0;
  }

  if (res.seedExhausted === true) {
    output.flags.tapeExhausted = true;
  }
};

/** 引擎级资源/强分支信号 → 输出字段与 flags */
const applyEngineSignals = (
  output: SealedOutput,
  res: NativeSealedRunResult
): void => {
  if (res.forceApplied !== undefined) {
    output.forceApplied = res.forceApplied;
  }

  if (res.gasUsed !== undefined) {
    output.gasUsed = res.gasUsed;
  }

  // 资源上限类失败，验证器按 fault 处理
  if ((output.thrown ?? "").includes("jsseal_gas_exhausted")) {
    output.flags.gasExhausted = true;
    output.flags.oom = true;
  }
};

/** 引擎 trace 事件挂到输出（仅 prog.trace 开启且引擎回了 traceJson 时） */
const attachTrace = (
  output: SealedOutput,
  res: NativeSealedRunResult
): void => {
  if (res.traceJson === undefined) {
    return;
  }

  try {
    output.trace = {
      // SAFETY: res.traceJson 是引擎 C 侧序列化的 TraceEvent 数组文本（traceJson 约定）
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- 跨 I/O 边界断言：产出方是引擎 trace 序列化，形状受控
      events: JSON.parse(res.traceJson) as TraceEvent[],
      truncated: res.traceTruncated === true,
    };
  } catch {
    output.trace = { events: [], truncated: true };
  }
};

export const runNative = (prog: GuestProgram): RawRunOutcome => {
  const seedMode = prog.sealMode === "replay" ? "replay" : "record";

  const res = runSealedNative({
    seedMode,
    prelude: prog.prelude,
    code: prog.code,
    captureTail: CAPTURE_TAIL,
    dumpExpr: DUMP_EXPR,
    memoryLimit: prog.memoryLimitBytes,
    timeoutMs: prog.timeoutMs,
    forceBranchIndex: prog.forceBranchIndex,
    gasLimit: prog.gasLimit,
    trace: prog.trace,
    seedTapes: {
      random: prog.tapes?.random ?? [],
      date: prog.tapes?.date ?? [],
      time: prog.tapes?.time ?? [],
      crypto: prog.tapes?.crypto ?? [],
    },
  });

  if (res.fault !== undefined || res.dump === undefined) {
    return { fault: res.fault ?? "dump-error", detail: res.detail ?? "" };
  }

  const output = applyFlagDetection(parseDump(res.dump));

  mergeEngineSeeds(output, res);
  applyEngineSignals(output, res);

  if (prog.trace !== undefined) {
    attachTrace(output, res);
  }

  return { output };
};
