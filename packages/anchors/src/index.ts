/**
 * \@jsseal/anchors — 验证锚库
 *
 * 锚点 = (输入代码, 种子磁带, 期望输出向量)。环境封闭后，同一 (代码, 磁带) 必须恒等地
 * 复现同一输出——这就是渐进式反混淆中每一步恒等变换的验证标准。
 */

import { runSealed } from "@jsseal/runtime";
import type {
  BackendKind,
  EntrySpec,
  EnvTemplate,
  FunctionPin,
  SealedOutput,
  SeedTapes,
} from "@jsseal/runtime";

import type { StructuralBranchAnchor } from "./branch-anchor";

export interface AnchorSample {
  tapes: SeedTapes;
  expected: SealedOutput;
  /** forced execution 锚点：翻转第 k 个执行的条件分支（多路径覆盖）；普通锚点无此字段 */
  forceIndex?: number;
  /** AST 路径锚定 v2：结构锚（形状签名+函数提示+出现次序+执行出现次序） */
  forceAnchor?: StructuralBranchAnchor;
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
  env?: EnvTemplate;
}

export interface OutputDiff {
  field: string;
  expected: string;
  actual: string;
}

/** compareOutputs 的比较结论：equal 即"无任何字段差异"，diffs 给出逐字段证据 */
export interface OutputComparison {
  equal: boolean;
  diffs: OutputDiff[];
}

/** 差异 → 单行诊断（`字段: 期望 → 实际`，多条以 " | " 连接） */
const describeDiffs = (diffs: OutputDiff[]): string =>
  diffs.map((d) => `${d.field}: ${d.expected} → ${d.actual}`).join(" | ");

/** 输出向量比较（规范化后逐字段；flags 属诊断信息，不参与相等判定） */
export const compareOutputs = (
  expected: SealedOutput,
  actual: SealedOutput
): OutputComparison => {
  const diffs: OutputDiff[] = [];

  const eq = <T>(field: string, expectedValue: T, actualValue: T): void => {
    const es = JSON.stringify(expectedValue);
    const as = JSON.stringify(actualValue);

    if (es !== as) {
      diffs.push({ field, expected: es, actual: as });
    }
  };

  eq("ok", expected.ok, actual.ok);
  eq("ret", expected.ret ?? null, actual.ret ?? null);
  eq("thrown", expected.thrown ?? null, actual.thrown ?? null);
  eq("console", expected.console, actual.console);
  eq("storage", expected.storage, actual.storage);
  eq("netLog", expected.netLog ?? [], actual.netLog ?? []);
  eq("consumed.random", expected.consumed.random, actual.consumed.random);
  eq("consumed.date", expected.consumed.date, actual.consumed.date);
  eq("consumed.time", expected.consumed.time, actual.consumed.time);
  eq("consumed.crypto", expected.consumed.crypto, actual.consumed.crypto);

  return { equal: diffs.length === 0, diffs };
};

interface SampleRecord {
  sample: AnchorSample | null;
  /** 失败诊断（与 sample 互斥） */
  note: string | null;
}

/** 单次 record 预跑 + 自检重放：失败只产诊断 note，由调用方统一累计降级 */
const recordSample = async (
  opts: CorpusOptions,
  backend: BackendKind,
  sampleIndex: number
): Promise<SampleRecord> => {
  let recorded: SealedOutput;

  try {
    recorded = await runSealed({
      code: opts.code,
      mode: "record",
      entry: opts.entry,
      timeoutMs: opts.timeoutMs,
      memoryLimitBytes: opts.memoryLimitBytes,
      env: opts.env,
      backend,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return {
      sample: null,
      note: `sample#${sampleIndex}: record fault: ${detail}`,
    };
  }

  if (recorded.flags.timeout === true || recorded.flags.oom === true) {
    const which = recorded.flags.timeout === true ? "timeout" : "oom";

    return {
      sample: null,
      note: `sample#${sampleIndex}: record ${which} — skipped`,
    };
  }

  // 自检：同一磁带重放原代码必须逐位复现
  try {
    const replayed = await runSealed({
      code: opts.code,
      mode: "replay",
      tapes: recorded.tapes,
      entry: opts.entry,
      timeoutMs: opts.timeoutMs,
      memoryLimitBytes: opts.memoryLimitBytes,
      env: opts.env,
      backend,
    });

    const { equal, diffs } = compareOutputs(recorded, replayed);

    if (!equal) {
      const fields = diffs.map((d) => d.field).join(",");

      return {
        sample: null,
        note: `sample#${sampleIndex}: self-check failed: ${fields}`,
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return {
      sample: null,
      note: `sample#${sampleIndex}: self-check fault: ${detail}`,
    };
  }

  return { sample: { tapes: recorded.tapes, expected: recorded }, note: null };
};

/** 采样造锚：N 次独立 record 预跑，每次冻结 (磁带, 期望输出)，并做自检重放 */
export const buildCorpus = async (opts: CorpusOptions): Promise<Corpus> => {
  const n = Math.max(1, opts.samples ?? 3);
  const backend: BackendKind = opts.backend ?? "quickjs";
  const samples: AnchorSample[] = [];
  const notes: string[] = [];
  let degraded = false;

  for (let i = 0; i < n; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- 逐样本串行预跑：样本序号决定 notes 次序，且每次 record 都是独立的熵扰动，并行会改变采样与失败归因
    const recorded = await recordSample(opts, backend, i);

    if (recorded.note !== null) {
      degraded = true;
      notes.push(recorded.note);
    }

    if (recorded.sample !== null) {
      samples.push(recorded.sample);
    }
  }

  if (samples.length === 0) {
    notes.push("corpus unusable: no self-consistent sample");
  }

  return { backend, samples, degraded, notes, entry: opts.entry };
};

export interface ValidationOutcome {
  pass: boolean;
  failures: { sample: number; kind: "diff" | "fault"; detail: string }[];
  checked: number;
}

/** 单条验证失败项（diff=输出不一致，fault=执行故障/屏障破坏） */
type ValidationFailure = ValidationOutcome["failures"][number];

/** validateCorpus 的可选运行参数（pins/时限/环境覆盖） */
export interface ValidationExtra {
  pins?: FunctionPin[];
  timeoutMs?: number;
  memoryLimitBytes?: number;
  env?: EnvTemplate;
}

interface SampleReplay {
  /** 该样本是否计入 checked（通过故障筛查后才进入比对） */
  counted: boolean;
  failure: ValidationFailure | null;
}

/** 单锚点比对判定：强制锚点走哨兵策略，普通锚点全输出比对 */
const compareSample = (
  sample: AnchorSample,
  actual: SealedOutput,
  sampleIndex: number
): ValidationFailure | null => {
  if (sample.forceIndex !== undefined) {
    if (sample.forceFullCompare === true) {
      // v2 结构锚迁移成功：强制的是"同一个分支"，全输出比对成立（等价于普通锚点）
      const { equal, diffs } = compareOutputs(sample.expected, actual);

      return equal
        ? null
        : {
            sample: sampleIndex,
            kind: "diff",
            detail: `forced(full) ${describeDiffs(diffs)}`,
          };
    }

    /* 强制锚点 = 路径健康哨兵：合法变换（死代码消除/重排）会缩短分支序列使序号前移，
     * 完整输出比对必然误报；降格为只比 ok 状态——强制路径上"原本正常 → 变换后抛错"
     * 即路径破坏（悬空引用类逃逸的捕获目标） */
    // v1 序号锚定：降格为 ok-only 哨兵（序号漂移下全比对必误报）
    return sample.expected.ok && !actual.ok
      ? {
          sample: sampleIndex,
          kind: "diff",
          detail: `forced-path broken: ${actual.thrown ?? "(crashed)"}`,
        }
      : null;
  }

  const { equal, diffs } = compareOutputs(sample.expected, actual);

  return equal
    ? null
    : { sample: sampleIndex, kind: "diff", detail: describeDiffs(diffs) };
};

/** 单锚点重放：故障直接判失败，否则交给比对判定 */
const replaySample = async (
  corpus: Corpus,
  code: string,
  sample: AnchorSample,
  sampleIndex: number,
  extra: ValidationExtra | undefined
): Promise<SampleReplay> => {
  let actual: SealedOutput;

  try {
    actual = await runSealed({
      code,
      mode: "replay",
      tapes: sample.tapes,
      entry: corpus.entry,
      backend: corpus.backend,
      pins: extra?.pins,
      forceBranchIndex: sample.forceIndex,
      timeoutMs: extra?.timeoutMs,
      memoryLimitBytes: extra?.memoryLimitBytes,
      env: extra?.env,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return {
      counted: false,
      failure: { sample: sampleIndex, kind: "fault", detail },
    };
  }

  if (actual.flags.tapeExhausted === true) {
    // 磁带耗尽 = 种子调用序被改变（屏障被破坏）→ 直接判失败
    const which = [
      `random:${actual.consumed.random}/${sample.tapes.random.length}`,
      `date:${actual.consumed.date}/${sample.tapes.date.length}`,
      `time:${actual.consumed.time}/${sample.tapes.time.length}`,
      `crypto:${actual.consumed.crypto}/${sample.tapes.crypto.length}`,
    ].join(" ");

    return {
      counted: false,
      failure: {
        sample: sampleIndex,
        kind: "fault",
        detail: `tape exhausted (barrier violation) [${which}]`,
      },
    };
  }

  if (actual.flags.timeout === true || actual.flags.oom === true) {
    return {
      counted: false,
      failure: {
        sample: sampleIndex,
        kind: "fault",
        detail: actual.flags.timeout === true ? "timeout" : "oom",
      },
    };
  }

  return { counted: true, failure: compareSample(sample, actual, sampleIndex) };
};

/** 验证：变换后的代码在每个锚点上重放，必须与期望输出恒等 */
export const validateCorpus = async (
  corpus: Corpus,
  code: string,
  extra?: ValidationExtra
): Promise<ValidationOutcome> => {
  const failures: ValidationFailure[] = [];
  let checked = 0;

  for (let i = 0; i < corpus.samples.length; i += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- 锚点验证必须串行：failures 的次序即样本次序，并行会打乱失败归因
    const outcome = await replaySample(
      corpus,
      code,
      corpus.samples[i],
      i,
      extra
    );

    if (outcome.counted) {
      checked += 1;
    }

    if (outcome.failure !== null) {
      failures.push(outcome.failure);
    }
  }

  return { pass: failures.length === 0 && checked > 0, failures, checked };
};

/* ======================== AST 路径锚定 v2（结构锚） ======================== */
export * from "./branch-anchor";
