/**
 * Native 后端（主力）：@jsseal/engine-native（quickjs-ng fork，N-API）。
 *
 * 种子拦截双层结构：
 *  - random/date/time/crypto → 引擎级（C 拦截 xorshift64star / date_now / js_perf_now /
 *    原生 crypto 注入，guest 不可觉察，toString 天然 [native code]）
 *  - crypto → 引擎级（JS_AddSealCrypto：原生 getRandomValues/randomUUID + 独立 crypto 磁带）
 * 磁带与消费计数在宿主侧合并成统一 SealedOutput。
 */

import { runSealedNative } from '@jsseal/engine-native';
import { CAPTURE_TAIL, DUMP_EXPR } from './prelude';
import { applyFlagDetection, parseDump, type RawRunOutcome } from './quickjs';
import type { GuestProgram } from './types';

export function runNative(prog: GuestProgram): RawRunOutcome {
  const seedMode = prog.sealMode === 'replay' ? 'replay' : 'record';
  const res = runSealedNative({
    prelude: prog.prelude,
    code: prog.code,
    captureTail: CAPTURE_TAIL,
    dumpExpr: DUMP_EXPR,
    memoryLimit: prog.memoryLimitBytes,
    timeoutMs: prog.timeoutMs,
    seedMode,
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
  if (res.fault || res.dump === undefined) {
    return { fault: res.fault ?? 'dump-error', detail: res.detail ?? '' };
  }
  const output = applyFlagDetection(parseDump(res.dump));

  // ---- 合并引擎磁带（crypto 保留 prelude 层）----
  if (res.seedTapes) {
    output.tapes.random = res.seedTapes.random;
    output.tapes.date = res.seedTapes.date;
    output.tapes.time = res.seedTapes.time;
    output.tapes.crypto = res.seedTapes.crypto ?? [];
  }
  if (res.seedConsumed) {
    output.consumed.random = res.seedConsumed.random;
    output.consumed.date = res.seedConsumed.date;
    output.consumed.time = res.seedConsumed.time;
    output.consumed.crypto = res.seedConsumed.crypto ?? 0;
  }
  if (res.seedExhausted) {
    output.flags.tapeExhausted = true;
  }
  if (res.forceApplied !== undefined) output.forceApplied = res.forceApplied;
  if (res.gasUsed !== undefined) output.gasUsed = res.gasUsed;
  if (String(output.thrown ?? '').includes('jsseal_gas_exhausted')) {
    output.flags.gasExhausted = true;
    output.flags.oom = true; /* 资源上限类失败，验证器按 fault 处理 */
  }
  if (prog.trace && res.traceJson !== undefined) {
    try {
      output.trace = { events: JSON.parse(res.traceJson), truncated: res.traceTruncated === true };
    } catch {
      output.trace = { events: [], truncated: true };
    }
  }
  return { output };
}
