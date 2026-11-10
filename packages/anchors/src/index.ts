/**
 * @jsseal/anchors — 验证锚库
 *
 * 锚点 = (输入代码, 种子磁带, 期望输出向量)。环境封闭后，同一 (代码, 磁带) 必须恒等地
 * 复现同一输出——这就是渐进式反混淆中每一步恒等变换的验证标准。
 */

import {
  runSealed,
  type BackendKind,
  type EntrySpec,
  type FunctionPin,
  type SealedOutput,
  type SeedTapes,
} from '@jsseal/runtime';

export interface AnchorSample {
  tapes: SeedTapes;
  expected: SealedOutput;
  /** forced execution 锚点：翻转第 k 个执行的条件分支（多路径覆盖）；普通锚点无此字段 */
  forceIndex?: number;
  /** AST 路径锚定 v2：结构锚（形状签名+函数提示+出现次序+执行出现次序） */
  forceAnchor?: import('./branch-anchor').StructuralBranchAnchor;
  /** v2：结构锚迁移成功后启用全输出比对（替代 ok-only 哨兵） */
  forceFullCompare?: boolean;
  /** forced 锚点对应的分支测试表达式指纹（结构身份——变换后用于存活检查与序号迁移） */
  forceFingerprint?: string;
}

export interface Corpus {
  backend: BackendKind;
  entry?: EntrySpec;
  samples: AnchorSample[];
  /** record 阶段就有样本超时/异常——锚库置信度降级，报告中标注 */
  degraded: boolean;
  notes: string[];
}

export interface CorpusOptions {
  code: string;
  /** 默认 3；每个样本是一次独立 record 预跑（天然熵扰动后各自冻结） */
  samples?: number;
  entry?: EntrySpec;
  backend?: BackendKind;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  env?: Record<string, unknown>;
}

export interface OutputDiff {
  field: string;
  expected: string;
  actual: string;
}

/** 输出向量比较（规范化后逐字段；flags 属诊断信息，不参与相等判定） */
export function compareOutputs(expected: SealedOutput, actual: SealedOutput): { equal: boolean; diffs: OutputDiff[] } {
  const diffs: OutputDiff[] = [];
  const eq = (field: string, e: unknown, a: unknown) => {
    const es = JSON.stringify(e);
    const as = JSON.stringify(a);
    if (es !== as) diffs.push({ field, expected: es, actual: as });
  };
  eq('ok', expected.ok, actual.ok);
  eq('ret', expected.ret ?? null, actual.ret ?? null);
  eq('thrown', expected.thrown ?? null, actual.thrown ?? null);
  eq('console', expected.console, actual.console);
  eq('storage', expected.storage, actual.storage);
  eq('netLog', expected.netLog ?? [], actual.netLog ?? []);
  eq('consumed.random', expected.consumed.random, actual.consumed.random);
  eq('consumed.date', expected.consumed.date, actual.consumed.date);
  eq('consumed.time', expected.consumed.time, actual.consumed.time);
  eq('consumed.crypto', expected.consumed.crypto, actual.consumed.crypto);
  return { equal: diffs.length === 0, diffs };
}

/** 采样造锚：N 次独立 record 预跑，每次冻结 (磁带, 期望输出)，并做自检重放 */
export async function buildCorpus(opts: CorpusOptions): Promise<Corpus> {
  const n = Math.max(1, opts.samples ?? 3);
  const backend: BackendKind = opts.backend ?? 'quickjs';
  const samples: AnchorSample[] = [];
  const notes: string[] = [];
  let degraded = false;

  for (let i = 0; i < n; i++) {
    let recorded: SealedOutput;
    try {
      recorded = await runSealed({
        code: opts.code,
        mode: 'record',
        entry: opts.entry,
        backend,
        timeoutMs: opts.timeoutMs,
        memoryLimitBytes: opts.memoryLimitBytes,
        env: opts.env as never,
      });
    } catch (e) {
      degraded = true;
      notes.push(`sample#${i}: record fault: ${(e as Error).message}`);
      continue;
    }
    if (recorded.flags.timeout || recorded.flags.oom) {
      degraded = true;
      notes.push(`sample#${i}: record ${recorded.flags.timeout ? 'timeout' : 'oom'} — skipped`);
      continue;
    }
    // 自检：同一磁带重放原代码必须逐位复现
    try {
      const replayed = await runSealed({
        code: opts.code,
        mode: 'replay',
        tapes: recorded.tapes,
        entry: opts.entry,
        backend,
        timeoutMs: opts.timeoutMs,
        memoryLimitBytes: opts.memoryLimitBytes,
        env: opts.env as never,
      });
      const { equal, diffs } = compareOutputs(recorded, replayed);
      if (!equal) {
        degraded = true;
        notes.push(`sample#${i}: self-check failed: ${diffs.map((d) => d.field).join(',')}`);
        continue;
      }
    } catch (e) {
      degraded = true;
      notes.push(`sample#${i}: self-check fault: ${(e as Error).message}`);
      continue;
    }
    samples.push({ tapes: recorded.tapes, expected: recorded });
  }

  if (samples.length === 0) {
    notes.push('corpus unusable: no self-consistent sample');
  }
  return { backend, entry: opts.entry, samples, degraded, notes };
}

export interface ValidationOutcome {
  pass: boolean;
  failures: { sample: number; kind: 'diff' | 'fault'; detail: string }[];
  checked: number;
}

/** 验证：变换后的代码在每个锚点上重放，必须与期望输出恒等 */
export async function validateCorpus(
  corpus: Corpus,
  code: string,
  extra?: { pins?: FunctionPin[]; timeoutMs?: number; memoryLimitBytes?: number; env?: Record<string, unknown> },
): Promise<ValidationOutcome> {
  const failures: ValidationOutcome['failures'] = [];
  let checked = 0;
  for (let i = 0; i < corpus.samples.length; i++) {
    const s = corpus.samples[i];
    let actual: SealedOutput;
    try {
      actual = await runSealed({
        code,
        mode: 'replay',
        tapes: s.tapes,
        entry: corpus.entry,
        backend: corpus.backend,
        pins: extra?.pins,
        forceBranchIndex: s.forceIndex,
        timeoutMs: extra?.timeoutMs,
        memoryLimitBytes: extra?.memoryLimitBytes,
        env: extra?.env as never,
      });
    } catch (e) {
      failures.push({ sample: i, kind: 'fault', detail: (e as Error).message });
      continue;
    }
    if (actual.flags.tapeExhausted) {
      // 磁带耗尽 = 种子调用序被改变（屏障被破坏）→ 直接判失败
      const which = [
        `random:${actual.consumed.random}/${s.tapes.random.length}`,
        `date:${actual.consumed.date}/${s.tapes.date.length}`,
        `time:${actual.consumed.time}/${s.tapes.time.length}`,
        `crypto:${actual.consumed.crypto}/${s.tapes.crypto.length}`,
      ].join(' ');
      failures.push({ sample: i, kind: 'fault', detail: `tape exhausted (barrier violation) [${which}]` });
      continue;
    }
    if (actual.flags.timeout || actual.flags.oom) {
      failures.push({ sample: i, kind: 'fault', detail: actual.flags.timeout ? 'timeout' : 'oom' });
      continue;
    }
    checked++;
    /* 强制锚点 = 路径健康哨兵：合法变换（死代码消除/重排）会缩短分支序列使序号前移，
     * 完整输出比对必然误报；降格为只比 ok 状态——强制路径上"原本正常 → 变换后抛错"
     * 即路径破坏（悬空引用类逃逸的捕获目标） */
    if (s.forceIndex !== undefined) {
      if (s.forceFullCompare) {
        // v2 结构锚迁移成功：强制的是"同一个分支"，全输出比对成立（等价于普通锚点）
        const { equal, diffs } = compareOutputs(s.expected, actual);
        if (!equal) {
          failures.push({ sample: i, kind: 'diff', detail: 'forced(full) ' + diffs.map((d) => `${d.field}: ${d.expected} → ${d.actual}`).join(' | ') });
        }
      } else if (s.expected.ok && !actual.ok) {
        // v1 序号锚定：降格为 ok-only 哨兵（序号漂移下全比对必误报）
        failures.push({ sample: i, kind: 'diff', detail: `forced-path broken: ${actual.thrown ?? '(crashed)'}` });
      }
      continue;
    }
    const { equal, diffs } = compareOutputs(s.expected, actual);
    if (!equal) {
      failures.push({ sample: i, kind: 'diff', detail: diffs.map((d) => `${d.field}: ${d.expected} → ${d.actual}`).join(' | ') });
    }
  }
  return { pass: failures.length === 0 && checked > 0, failures, checked };
}

/* ======================== AST 路径锚定 v2（结构锚） ======================== */
export * from './branch-anchor';
