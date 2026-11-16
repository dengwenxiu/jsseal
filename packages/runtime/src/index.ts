/**
 * \@jsseal/runtime — 封闭执行内核
 *
 * 用法：
 *   const out = await runSealed(\{ code, mode: 'record' \});        // 预跑：录制种子磁带 + 稳定输出
 *   const out2 = await runSealed(\{ code, mode: 'replay', tapes: out.tapes \}); // 重放：必须逐位一致
 */

import { runNative } from "./native";
import { runNodeVm } from "./nodevm";
import { buildEntryTail, buildPrelude, emptyTapes } from "./prelude";
import { runQuickJS } from "./quickjs";
import type { RawRunOutcome } from "./quickjs";
import { DEFAULT_MEMORY_LIMIT, DEFAULT_TIMEOUT_MS } from "./types";
import type {
  BackendKind,
  GuestProgram,
  SealedOutput,
  SealedRunOptions,
} from "./types";

export * from "./types";

export { emptyTapes };

export class SealedRunError extends Error {
  readonly fault: string;
  readonly detail: string;

  constructor(fault: string, detail: string) {
    super(`sealed run fault=${fault}: ${detail}`);
    this.name = "SealedRunError";
    this.fault = fault;
    this.detail = detail;
  }
}

/** 按后端分派到具体执行器（nodevm/native 同步，quickjs 异步） */
const runBackend = async (
  backend: BackendKind,
  prog: GuestProgram
): Promise<RawRunOutcome> => {
  if (backend === "nodevm") {
    return runNodeVm(prog);
  }

  if (backend === "native") {
    return runNative(prog);
  }

  return await runQuickJS(prog);
};

export const runSealed = async (
  opts: SealedRunOptions
): Promise<SealedOutput> => {
  const backend: BackendKind = opts.backend ?? "quickjs";

  const tapes =
    opts.mode === "replay" ? (opts.tapes ?? emptyTapes()) : emptyTapes();

  const prelude = buildPrelude({
    mode: opts.mode,
    pins: opts.pins ?? [],
    entry: opts.entry,
    env: opts.env,
    engineSeeds: backend === "native",
    envProbe: opts.envProbe,
    envTrace: opts.envTrace,
    netFixtures: opts.netFixtures,
    tapes,
  });

  // 插桩旁路：闭包注入 dbg（guest 无法枚举——不在任何全局对象上）
  const instrument = opts.instrument ?? "";

  const instrumentPrefix =
    instrument === ""
      ? ""
      : `;try { (function (dbg) {\n${instrument}\n})(globalThis.__jsseal.dbg); } catch (__ierr) { globalThis.__jsseal.dbg('[instrument] error:', String(__ierr)); }\n`;

  // hashbang 剥离 + 插桩 + 用户代码 + 入口尾巴（同一 program）
  const userCode = opts.code.replace(/^#![^\n]*\n?/u, "");
  const code = instrumentPrefix + userCode + buildEntryTail(opts.entry);

  const prog: GuestProgram = {
    prelude,
    code,
    tapes,
    tail: "",
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryLimitBytes: opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT,
    sealMode: opts.mode,
    gasLimit: opts.gasLimit,
    trace: opts.trace,
    envProbe: opts.envProbe,
    forceBranchIndex: opts.forceBranchIndex,
  };

  const outcome = await runBackend(backend, prog);

  if (outcome.fault !== undefined || outcome.output === undefined) {
    throw new SealedRunError(outcome.fault ?? "unknown", outcome.detail ?? "");
  }

  return outcome.output;
};
