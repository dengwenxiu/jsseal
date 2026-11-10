/**
 * @jsseal/runtime — 封闭执行内核
 *
 * 用法：
 *   const out = await runSealed({ code, mode: 'record' });        // 预跑：录制种子磁带 + 稳定输出
 *   const out2 = await runSealed({ code, mode: 'replay', tapes: out.tapes }); // 重放：必须逐位一致
 */

import { buildEntryTail, buildPrelude, emptyTapes } from './prelude';
import { runNodeVm } from './nodevm';
import { runNative } from './native';
import { runQuickJS } from './quickjs';
import {
  DEFAULT_MEMORY_LIMIT,
  DEFAULT_TIMEOUT_MS,
  type BackendKind,
  type GuestProgram,
  type SealedOutput,
  type SealedRunOptions,
} from './types';

export * from './types';
export { emptyTapes };

export class SealedRunError extends Error {
  constructor(
    public readonly fault: string,
    public readonly detail: string,
  ) {
    super(`sealed run fault=${fault}: ${detail}`);
    this.name = 'SealedRunError';
  }
}

export async function runSealed(opts: SealedRunOptions): Promise<SealedOutput> {
  const backend: BackendKind = opts.backend ?? 'quickjs';
  const tapes = opts.mode === 'replay' ? (opts.tapes ?? emptyTapes()) : emptyTapes();

  const prelude = buildPrelude({
    mode: opts.mode,
    tapes,
    pins: opts.pins ?? [],
    entry: opts.entry,
    env: opts.env,
    engineSeeds: backend === 'native',
    envProbe: opts.envProbe,
    envTrace: opts.envTrace,
    netFixtures: opts.netFixtures,
  });
  // 插桩旁路：闭包注入 dbg（guest 无法枚举——不在任何全局对象上）
  const instrumentPrefix = opts.instrument
    ? `;try { (function (dbg) {\n${opts.instrument}\n})(globalThis.__jsseal.dbg); } catch (__ierr) { globalThis.__jsseal.dbg('[instrument] error:', String(__ierr)); }\n`
    : '';
  // hashbang 剥离 + 插桩 + 用户代码 + 入口尾巴（同一 program）
  const userCode = opts.code.replace(/^#![^\n]*\n?/, '');
  const code = instrumentPrefix + userCode + buildEntryTail(opts.entry);

  const prog: GuestProgram = {
    prelude,
    code,
    tail: '',
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryLimitBytes: opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT,
    sealMode: opts.mode,
    tapes,
    gasLimit: opts.gasLimit,
    trace: opts.trace,
    envProbe: opts.envProbe,
    forceBranchIndex: opts.forceBranchIndex,
  };

  const outcome = backend === 'nodevm' ? runNodeVm(prog) : backend === 'native' ? runNative(prog) : await runQuickJS(prog);
  if (outcome.fault || !outcome.output) {
    throw new SealedRunError(outcome.fault ?? 'unknown', outcome.detail ?? '');
  }
  return outcome.output;
}
