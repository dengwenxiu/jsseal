/**
 * node:vm 备用后端（开发/调试用；非安全边界，生产使用 quickjs 后端）。
 * prelude 与 quickjs 后端完全一致，保证行为对齐（引擎差异除外——
 * 锚库比较必须固定在同一后端内进行）。
 */

import * as vm from 'node:vm';
import { CAPTURE_TAIL, DUMP_EXPR } from './prelude';
import type { GuestProgram, SealedOutput } from './types';
import type { RawRunOutcome } from './quickjs';

export function runNodeVm(prog: GuestProgram): RawRunOutcome {
  const context = vm.createContext({}, { codeGeneration: { strings: true, wasm: false } });
  try {
    vm.runInContext(prog.prelude, context, { filename: 'jsseal-prelude.js' });
    let completion: unknown;
    let threw: unknown = undefined;
    try {
      completion = vm.runInContext(prog.code, context, {
        filename: 'input.js',
        timeout: prog.timeoutMs,
      });
    } catch (e) {
      threw = e;
    }
    (context as { __jsseal_last?: unknown }).__jsseal_last = threw === undefined ? completion : undefined;
    (context as { __jsseal_err?: unknown }).__jsseal_err = threw;
    try {
      vm.runInContext(CAPTURE_TAIL, context, { filename: 'jsseal-capture.js' });
    } catch {
      /* ignore */
    }
    const json = vm.runInContext(DUMP_EXPR, context, { filename: 'jsseal-dump.js' }) as string;
    const output = JSON.parse(json) as SealedOutput;
    output.console ??= [];
    output.storage ??= {};
    output.consumed ??= { random: 0, date: 0, time: 0, crypto: 0 };
    output.tapes ??= { random: [], date: [], time: [], crypto: [] };
    output.flags ??= {};
    const thrown = String(output.thrown ?? '');
    if (output.flags.tapeExhausted || thrown.includes('__JSSEAL_TAPE_EXHAUSTED__')) {
      output.flags.tapeExhausted = true;
    }
    if (thrown.includes('Script execution timed out')) output.flags.timeout = true;
    return { output };
  } catch (e) {
    return { fault: 'dump-error', detail: String(e) };
  }
}
