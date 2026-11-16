/**
 * `@jsseal/core` — 渐进式反编排（governor）+ 管线编排
 *
 * 宪法执行处：每个变换提案（规则/未来 LLM）都必须在锚库上重放验证，
 * 通过才提交，失败即回滚；连续失败 2 次的变换对本文件禁用。
 * 锚库不可用（无法封闭）时拒绝变换，原样返回——没有验证锚点就没有变换。
 */

import * as t from "@babel/types";
import {
  anchorOf,
  buildCorpus,
  collectBranchNodes,
  execOccurrencesOfTrace,
  resolveForceIndex,
  validateCorpus,
} from "@jsseal/anchors";
import type { AnchorSample, Corpus, ValidationOutcome } from "@jsseal/anchors";
import {
  freeVariables,
  hashCode,
  parseCode,
  printCode,
  traverse,
} from "@jsseal/ast";
import { detect } from "@jsseal/detector";
import type { Detection } from "@jsseal/detector";
import { isEngineAvailable } from "@jsseal/engine-native";
import type { AuditReport } from "@jsseal/env-kit";
import { runSealed } from "@jsseal/runtime";
import type {
  BackendKind,
  EntrySpec,
  EnvTemplate,
  FunctionPin,
  SealedOutput,
} from "@jsseal/runtime";
import { defaultPipeline } from "@jsseal/transforms";
import type { Transform, TransformResult } from "@jsseal/transforms";

export interface DeobfuscateOptions {
  code: string;
  entry?: EntrySpec;
  samples?: number;
  maxRounds?: number;
  backend?: BackendKind;
  /** 环境模板（透传封闭运行时） */
  env?: EnvTemplate;
  /** 网络 fixture（VCR，透传封闭运行时） */
  netFixtures?: Record<string, { status?: number; body?: string }>;
  /** forced execution 锚点数上限（native；0=关闭，默认 8）——多路径覆盖 */
  forcedBranches?: number;
  /** 插桩旁路：闭包注入 dbg(...)（零全局足迹，输出走 debugLog 不进锚库） */
  instrument?: string;
  /** 访问图谱：记录 stub 对象全部属性访问（SDK 探测面地图） */
  envTrace?: boolean;
  timeoutMs?: number;
  memoryLimitBytes?: number;
  transforms?: Transform[];
  /** 只检测 + 建锚库，不做变换（诊断模式） */
  detectOnly?: boolean;
  /** 锚库自检失败时是否仍尝试变换（默认 false：宪法要求有锚点才变换） */
  forceWithoutAnchors?: boolean;
}

export interface AppliedRecord {
  name: string;
  round: number;
  notes: string[];
}

export interface RollbackRecord {
  name: string;
  round: number;
  reason: string;
}

export interface DeobfuscateReport {
  inputHash: string;
  outputHash: string;
  backend?: BackendKind;
  detection: Detection;
  corpus: { samples: number; degraded: boolean; notes: string[] };
  rounds: number;
  applied: AppliedRecord[];
  rolledBack: RollbackRecord[];
  finalCode: string;
  finalValidation: (ValidationOutcome & { skipped?: boolean }) | null;
  missingEnv: Record<string, number>;
  /** 运行时环境缺失访问（env-probe：stub 对象上被访问但不存在的属性） */
  envMisses: Record<string, number>;
  /** 网络请求日志（VCR）：样本发出的全部请求 */
  netLog: { method: string; url: string; body: string | null }[];
  /** fixture 未命中的 url（缺流量报缺） */
  netMisses: string[];
  /** forced execution 锚点数（多路径覆盖） */
  forcedAnchors: number;
  /** 环境封闭阶段的种子消费概览（样本 0） */
  sealOverview: {
    console: number;
    storage: number;
    consumed: Record<string, number>;
    flags: Record<string, boolean | undefined>;
  } | null;
}

/** 带源码区间的节点（quickjs 解析出的边缘节点可能缺 start/end） */
type RangedNode = t.Node & { start: number; end: number };

const hasRange = (node: t.Node): node is RangedNode =>
  typeof node.start === "number" && typeof node.end === "number";

/** pin 候选：推断出的名字（可缺省）+ 截取文本用节点 */
interface PinCandidate {
  name?: string;
  node: t.Node;
}

/** 属性名推断：标识符 / 字符串字面量键 → 名字（其他形态无推断名） */
const propertyNameOf = (key: t.Node): string | undefined => {
  if (t.isIdentifier(key)) {
    return key.name;
  }

  if (t.isStringLiteral(key)) {
    return key.value;
  }

  return undefined;
};

/** 节点 → pin 候选（名字 + 截取节点）；无推断名返回 undefined 名字 */
const pinCandidateOf = (node: t.Node): PinCandidate => {
  if (t.isFunctionDeclaration(node)) {
    return { name: node.id?.name, node };
  }

  if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
    const { init } = node;

    if (t.isArrowFunctionExpression(init)) {
      return { name: node.id.name, node };
    }

    if (t.isFunctionExpression(init)) {
      return { name: init.id?.name ?? node.id.name, node };
    }

    return { node };
  }

  if (t.isAssignmentExpression(node) && t.isMemberExpression(node.left)) {
    const { right } = node;

    if (t.isFunctionExpression(right) && right.id === null) {
      return { name: propertyNameOf(node.left.property), node };
    }

    return { node };
  }

  if (t.isObjectProperty(node)) {
    const { value } = node;

    const isAnonymousFunction =
      (t.isFunctionExpression(value) && value.id === null) ||
      t.isArrowFunctionExpression(value);

    if (isAnonymousFunction) {
      return { name: propertyNameOf(node.key), node };
    }
  }

  return { node };
};

/**
 * 从原始代码构建 FunctionPin（toString 钉死数据源）。
 * 覆盖有推断名的函数：函数声明 / var 赋值 / 对象属性与原型方法赋值
 * （selfDefending 的检测函数通常挂在 prototype 方法上）。
 */
export const buildPins = (code: string): FunctionPin[] => {
  const pins: FunctionPin[] = [];
  const seen = new Set<string>();

  const push = (name: string | undefined, node: t.Node): void => {
    if (!hasRange(node)) {
      return;
    }

    if (name === undefined || name === "" || seen.has(name)) {
      return;
    }

    seen.add(name);
    pins.push({ name, text: code.slice(node.start, node.end) });
  };

  try {
    const ast = parseCode(code);

    traverse(ast, {
      "FunctionDeclaration|VariableDeclarator|AssignmentExpression|ObjectProperty"(
        path
      ) {
        const candidate = pinCandidateOf(path.node);

        push(candidate.name, candidate.node);
      },
    });
  } catch {
    /* 解析失败返回空 pins */
  }

  return pins;
};

/** demangle 后同步 pins 键名（同名映射到多个新名 → 放弃该 pin，保守） */
const rekeyPins = (
  pins: FunctionPin[],
  pairs: { from: string; to: string }[]
): FunctionPin[] => {
  const targetsByName = new Map<string, Set<string>>();

  for (const { from, to } of pairs) {
    const targets = targetsByName.get(from) ?? new Set<string>();

    targets.add(to);
    targetsByName.set(from, targets);
  }

  const renamed = new Map<string, string>();

  for (const [from, targets] of targetsByName) {
    if (targets.size === 1) {
      const [to] = [...targets];

      renamed.set(from, to);
    }
  }

  const rekeyed: FunctionPin[] = [];

  for (const pin of pins) {
    const nextName = renamed.get(pin.name) ?? pin.name;

    if (pin.text.length > 0) {
      rekeyed.push({ name: nextName, text: pin.text });
    }
  }

  return rekeyed;
};

const summarizeValidation = (outcome: ValidationOutcome): string => {
  if (outcome.failures.length === 0) {
    return "unknown";
  }

  const [failure] = outcome.failures;

  return `sample#${failure.sample} ${failure.kind}: ${failure.detail.slice(0, 200)}`;
};

/** 默认后端：native 引擎可用则 native（主力），否则降级 quickjs(wasm) */
const defaultBackend = (): BackendKind => {
  try {
    return isEngineAvailable() ? "native" : "quickjs";
  } catch {
    return "quickjs";
  }
};

const missingEnvOf = (code: string): Record<string, number> => {
  try {
    return Object.fromEntries(freeVariables(parseCode(code)));
  } catch {
    return {};
  }
};

/** 候选代码的自然分支执行序（replay 录制；录制失败按空序处理 → 丢弃强制锚） */
const probeBranchLines = async (
  code: string,
  corpus: Corpus,
  backend: BackendKind,
  timeoutMs?: number,
  memoryLimitBytes?: number
): Promise<number[]> => {
  try {
    const natural = await runSealed({
      code,
      backend,
      timeoutMs,
      memoryLimitBytes,
      mode: "replay",
      tapes: corpus.samples[0].tapes,
      entry: corpus.entry,
      trace: { branches: true },
    });

    return (natural.trace?.events ?? []).flatMap((event) =>
      event.k === "br" && event.l !== undefined ? [event.l] : []
    );
  } catch {
    return [];
  }
};

/** 报告的封闭概览段（环境种子消费 / 存储写入计数） */
const sealOverviewOf = (
  sample: SealedOutput | null
): DeobfuscateReport["sealOverview"] => {
  if (sample === null) {
    return null;
  }

  return {
    console: sample.console.length,
    storage: Object.keys(sample.storage).length,
    consumed: sample.consumed,
    flags: sample.flags,
  };
};

/* oxlint-disable complexity, sonarjs/cognitive-complexity -- governor 语义探针：提交/回滚顺序即宪法 */
export const deobfuscate = async (
  opts: DeobfuscateOptions
): Promise<DeobfuscateReport> => {
  const backend = opts.backend ?? defaultBackend();
  const detection = detect(opts.code);
  const pipeline = opts.transforms ?? defaultPipeline;
  const maxRounds = opts.maxRounds ?? 6;

  // ---------- 阶段 B/C：环境封闭 + 采样造锚 ----------
  const corpus: Corpus = await buildCorpus({
    code: opts.code,
    samples: opts.samples ?? 3,
    entry: opts.entry,
    timeoutMs: opts.timeoutMs,
    memoryLimitBytes: opts.memoryLimitBytes,
    backend,
  });

  // ---------- forced execution：第 k 个执行的条件分支取反锚点（多路径覆盖） ----------
  let forcedAnchors = 0;
  // 默认关闭：序号锚定在重度结构变换下会漂移（见 docs §17）
  const maxForced = backend === "native" ? (opts.forcedBranches ?? 0) : 0;

  if (maxForced > 0 && corpus.samples.length > 0) {
    // v2 AST 路径锚定：结构锚（形状签名+函数提示+出现次序）。
    // br trace 的第 k 个事件 = 被强制的分支（行号）→ 原 AST 定位节点 → 结构锚
    const origBranchNodes = collectBranchNodes(parseCode(opts.code));

    for (let k = 1; k <= maxForced; k += 1) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- 强制锚点必须按序号 k 串行录制，并发会打乱分支执行序（语义要求）
        const run = await runSealed({
          code: opts.code,
          mode: "record",
          entry: opts.entry,
          timeoutMs: opts.timeoutMs,
          memoryLimitBytes: opts.memoryLimitBytes,
          forceBranchIndex: k,
          trace: { branches: true },
          env: opts.env,
          backend,
        });

        if (
          run.forceApplied === true &&
          run.flags.timeout !== true &&
          run.flags.oom !== true
        ) {
          const branchLines: number[] = [];

          for (const event of run.trace?.events ?? []) {
            if (event.k === "br" && event.l !== undefined) {
              branchLines.push(event.l);
            }
          }

          // 第 k 个 br 事件的 (行号, 该行第 m 次执行) → 原 AST 节点
          const kthLine = branchLines[k - 1];

          if (kthLine !== undefined) {
            const occ = execOccurrencesOfTrace(branchLines)[k - 1];

            // 精确行匹配（先 test 行后语句行）——±1 容差在紧凑代码（分支相邻行）
            // 会把锚劫持到邻居分支，实测导致强制错位全比对误报（踩坑）
            const node =
              origBranchNodes.find((n) => n.line === kthLine) ??
              origBranchNodes.find((n) => n.stmtLine === kthLine);

            if (node) {
              corpus.samples.push({
                tapes: run.tapes,
                expected: run,
                forceIndex: k,
                forceAnchor: anchorOf(node, occ.execOccurrence),
              });
              forcedAnchors += 1;
              continue;
            }
          }

          // 定位失败 → v1 行为：指纹 + ok-only 哨兵
          corpus.samples.push({
            tapes: run.tapes,
            expected: run,
            forceIndex: k,
          });
          forcedAnchors += 1;
        }
      } catch {
        /* 序号 k 超出分支执行数则 forceApplied=false，自然跳过 */
      }
    }
  }

  // ---------- 环境探针 + 网络 VCR 日志：一次 record 运行收集 ----------
  let envMisses: Record<string, number> = {};
  let netLog: { method: string; url: string; body: string | null }[] = [];
  let netMisses: string[] = [];

  try {
    const probeRun = await runSealed({
      code: opts.code,
      mode: "record",
      entry: opts.entry,
      timeoutMs: opts.timeoutMs,
      memoryLimitBytes: opts.memoryLimitBytes,
      envProbe: true,
      netFixtures: opts.netFixtures,
      backend,
    });

    envMisses = probeRun.envMisses ?? {};
    netLog = probeRun.netLog ?? [];
    netMisses = probeRun.netMisses ?? [];
  } catch {
    /* 探测失败不阻断 */
  }

  const sealSample = corpus.samples[0]?.expected ?? null;
  let current = opts.code;
  const applied: AppliedRecord[] = [];
  const rolledBack: RollbackRecord[] = [];
  const disabled = new Map<string, number>();

  if (corpus.samples.length === 0 && opts.forceWithoutAnchors !== true) {
    // 宪法：没有锚点就没有变换
    const finalCode = opts.code;

    return {
      inputHash: hashCode(opts.code),
      outputHash: hashCode(finalCode),
      corpus: { samples: 0, degraded: true, notes: corpus.notes },
      rounds: 0,
      finalValidation: { pass: false, failures: [], checked: 0, skipped: true },
      sealOverview: sealOverviewOf(sealSample),
      missingEnv: missingEnvOf(finalCode),
      finalCode,
      applied,
      rolledBack,
      backend,
      detection,
      envMisses,
      netLog,
      netMisses,
      forcedAnchors,
    };
  }

  // ---------- 阶段 E/F：渐进变换（逐条锚库验证） ----------
  let pins = buildPins(opts.code);
  let rounds = 0;

  if (opts.detectOnly !== true) {
    let aborted = false;

    for (let round = 1; round <= maxRounds && !aborted; round += 1) {
      rounds = round;
      let changedAny = false;

      // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- 每个 continue 对应一条独立的跳过理由（已禁用/抛出/未改动/无文本差异），合并会掩盖回滚计数
      for (const transform of pipeline) {
        const fails = disabled.get(transform.name) ?? 0;

        if (fails >= 2) {
          continue;
        }

        let ast: t.File;

        try {
          ast = parseCode(current);
        } catch (error) {
          rolledBack.push({
            round,
            name: "(parse)",
            reason: error instanceof Error ? error.message : String(error),
          });
          aborted = true;
          break;
        }

        let res: TransformResult;

        try {
          // oxlint-disable-next-line no-await-in-loop -- 变换必须逐条串行验证（并行会破坏锚库时序与确定性）
          res = await transform.run(ast, {
            code: current,
            timeoutMs: opts.timeoutMs,
            memoryLimitBytes: opts.memoryLimitBytes,
            detection,
            backend,
            corpus,
          });
        } catch (error) {
          rolledBack.push({
            round,
            name: transform.name,
            reason: `threw: ${error instanceof Error ? error.message : String(error)}`,
          });
          disabled.set(transform.name, fails + 1);
          continue;
        }

        if (!res.changed) {
          continue;
        }

        const candidate = printCode(ast);

        if (candidate === current) {
          continue;
        }

        // 强制锚点指纹存活检查：结构变换（死代码消除/CFF 还原）可能删除或移动分支，
        // 原序号不再可靠。用指纹检查分支是否仍存在：
        //   - 存在 → 用迁移后的新序号（buildMigration 自动映射）
        //   - 不存在 → 跳过该强制锚点（分支已被合法消除）
        let effectiveCorpus = corpus;

        const forcedSamples = corpus.samples.filter(
          (s2) => s2.forceIndex !== undefined
        );

        if (forcedSamples.some((s2) => s2.forceAnchor)) {
          // v2 结构锚迁移：锚 → 候选代码节点（分层匹配）→ 候选 br trace → 新执行序。
          // 迁移成功 → forceFullCompare（全输出比对，等价普通锚点）；
          // 失败 → 丢弃该锚（分支被合法消除，同 v1 语义）
          const candidateAst = parseCode(candidate);
          const candidateNodes = collectBranchNodes(candidateAst);

          // oxlint-disable-next-line no-await-in-loop -- 候选代码的自然执行序必须在本轮迁移前录制完成（保序，不可并行）
          const traceLines = await probeBranchLines(
            candidate,
            corpus,
            backend,
            opts.timeoutMs,
            opts.memoryLimitBytes
          );

          const adjusted = corpus.samples.flatMap((s2): AnchorSample[] => {
            // 无结构锚的样本原样保留（普通锚点 / 仅指纹的强制锚点）
            if (s2.forceIndex === undefined || !s2.forceAnchor) {
              return [s2];
            }

            const newIndex = resolveForceIndex(
              s2.forceAnchor,
              candidateNodes,
              traceLines
            );

            // 分支被消除 / 定位失败 → 丢弃该强制锚
            if (newIndex === null || newIndex < 1) {
              return [];
            }

            return [{ ...s2, forceIndex: newIndex, forceFullCompare: true }];
          });

          effectiveCorpus = { ...corpus, samples: adjusted };
        }

        // oxlint-disable-next-line no-await-in-loop -- 每个候选都必须先逐位验证再提交/回滚（顺序即宪法）
        const v = await validateCorpus(effectiveCorpus, candidate, {
          pins,
          timeoutMs: opts.timeoutMs,
          memoryLimitBytes: opts.memoryLimitBytes,
        });

        if (v.pass) {
          current = candidate;
          changedAny = true;
          applied.push({ round, name: transform.name, notes: res.notes });

          if (res.renamePairs !== undefined && res.renamePairs.length > 0) {
            pins = rekeyPins(pins, res.renamePairs);
          }
        } else {
          rolledBack.push({
            round,
            name: transform.name,
            reason: summarizeValidation(v),
          });
          disabled.set(transform.name, fails + 1);
        }
      }

      if (!changedAny) {
        break;
      }
    }
  }

  // ---------- 终验 ----------
  const finalValidation =
    corpus.samples.length > 0
      ? await validateCorpus(corpus, current, {
          pins,
          timeoutMs: opts.timeoutMs,
        })
      : { pass: false, failures: [], checked: 0, skipped: true };

  return {
    inputHash: hashCode(opts.code),
    outputHash: hashCode(current),
    corpus: {
      samples: corpus.samples.length,
      degraded: corpus.degraded,
      notes: corpus.notes,
    },
    sealOverview: sealOverviewOf(sealSample),
    finalCode: current,
    missingEnv: missingEnvOf(current),
    rounds,
    finalValidation,
    applied,
    rolledBack,
    backend,
    detection,
    envMisses,
    netLog,
    netMisses,
    forcedAnchors,
  };
};

/* oxlint-enable complexity, sonarjs/cognitive-complexity */

/** 便捷：只做检测与封闭诊断 */
export const diagnose = async (
  opts: DeobfuscateOptions
): Promise<DeobfuscateReport> =>
  await deobfuscate({ ...opts, detectOnly: true });

export { runSealed };

/* ================= 侦察模式（probe） ================= */

export interface ProbeReport {
  family: string;
  confidence: number;
  features: string[];
  /** 封闭运行（record，环境探针开启） */
  run: {
    ok: boolean;
    ret?: string;
    thrown?: string;
    console: { level: string; text: string }[];
    storage: Record<string, string>;
    netLog: { method: string; url: string; body: string | null }[];
    netMisses: string[];
    envMisses: Record<string, number>;
    evalLog: string[];
    consumed: Record<string, number>;
    flags: Record<string, boolean | undefined>;
    gasUsed?: number;
  };
  /** 字符串池预览（decoded=true 为解码明文；false 为编码态原始池——双参 RC4 等无法单参扫描） */
  pool?: { decoded: boolean; items: string[] };
  /** 环境审计（认知库对齐情况：环境即封闭边界，缺口=风控感知面） */
  envAudit?: AuditReport;
  /** 访问图谱（envTrace）：SDK 实际探测面（含已有与缺失属性的访问计数） */
  accessMap?: Record<string, number>;
  /** 插桩旁路输出（instrument 的 dbg 调用） */
  debugLog?: string[];
  missingEnv: Record<string, number>;
  /** 还原度告警：验证 PASS 不代表还原成功（外部 Agent 实测教训） */
  warnings: string[];
}

/** decoder 扫描回传（driver 生成的 JSON：命中数 + 明文预览） */
interface DecoderScan {
  n: number;
  out: string[];
}

/** driver 回传的 JSON 体（形态由调用点用类型守卫收窄） */
interface ProbeReply {
  value: unknown;
}

/** 字符串元素判定（类型守卫——边界解码的唯一收窄手段） */
const isString = (value: unknown): value is string => typeof value === "string";

/** 任意数组（池长度探测用；元素契约由各调用点自行收窄） */
const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

/** 池数组：全字符串才视为池内容 */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

/** decoder 扫描回传：命中数 n + 明文预览 out */
const isDecoderScan = (value: unknown): value is DecoderScan => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("n" in value) || typeof value.n !== "number") {
    return false;
  }

  if (!("out" in value)) {
    return false;
  }

  return isStringArray(value.out);
};

/** 解码字符串池明文：按池长度定扫描区间对 decoder 求值；
 * 单参扫描失败（RC4 双参等）回退到池原始内容（编码态，仍具侦察价值） */
const readPool = async (
  detection: Detection,
  backend: BackendKind,
  timeoutMs?: number
): Promise<{ decoded: boolean; items: string[] } | undefined> => {
  const plan = detection.obfuscatorIO;

  if (!plan || !plan.prologueSource) {
    return undefined;
  }

  const run = async (driver: string): Promise<ProbeReply | null> => {
    const out = await runSealed({
      code: `${plan.prologueSource}\n${driver}`,
      mode: "record",
      backend,
      timeoutMs,
    });

    if (
      out.flags.tapeExhausted === true ||
      out.flags.timeout === true ||
      out.flags.oom === true
    ) {
      return null;
    }

    try {
      const parsed: unknown = JSON.parse(out.ret ?? "null");

      return { value: parsed };
    } catch {
      return null;
    }
  };

  // 池长度（原始数组）
  const [arrName] = plan.stringArrayNames;
  let poolLen = 1024;

  if (arrName) {
    const reply = await run(
      `globalThis.__jsseal_ret_raw = JSON.stringify(typeof ${arrName} === 'function' ? ${arrName}() : null);`
    );

    if (reply !== null && isUnknownArray(reply.value)) {
      poolLen = reply.value.length;
    }
  }

  // decoder 扫描（单参；带 key 的 RC4 解码器此处会失败/产出乱码——decoded 标志区分）
  if (plan.decoderNames.length > 0) {
    const [dec] = plan.decoderNames;

    const reply = await run(`
var __out = [];
for (var __i = 0; __i < ${Math.min(poolLen + 1024, 65_536)}; __i++) {
  try {
    var __v = globalThis[${JSON.stringify(dec)}](__i);
    if (typeof __v === 'string' && __v.length > 0) __out.push(__v);
  } catch (e) {}
}
globalThis.__jsseal_ret_raw = JSON.stringify({ n: __out.length, out: __out.slice(0, 512) });
`);

    if (
      reply !== null &&
      isDecoderScan(reply.value) &&
      reply.value.n >= Math.min(4, poolLen / 4)
    ) {
      return { decoded: true, items: [...new Set(reply.value.out)] };
    }
  }

  // 回退：原始池（编码态）
  if (arrName) {
    const reply = await run(
      `globalThis.__jsseal_ret_raw = JSON.stringify(typeof ${arrName} === 'function' ? ${arrName}() : null);`
    );

    if (
      reply !== null &&
      isStringArray(reply.value) &&
      reply.value.length > 0
    ) {
      return { decoded: false, items: reply.value.slice(0, 512) };
    }
  }

  return undefined;
};

/** 侦察：安全封闭跑一遍样本，全维度报告（分析员工作流的第一步） */
export const probe = async (opts: DeobfuscateOptions): Promise<ProbeReport> => {
  const backend = opts.backend ?? defaultBackend();
  const detection = detect(opts.code);

  const out = await runSealed({
    code: opts.code,
    mode: "record",
    instrument: opts.instrument,
    envTrace: opts.envTrace,
    entry: opts.entry,
    timeoutMs: opts.timeoutMs,
    memoryLimitBytes: opts.memoryLimitBytes,
    envProbe: true,
    netFixtures: opts.netFixtures,
    env: opts.env,
    backend,
  });

  const pool = await readPool(detection, backend, opts.timeoutMs);
  const missingEnv = missingEnvOf(opts.code);

  let envAudit: AuditReport | undefined;

  try {
    const { auditEnv } = await import("@jsseal/env-kit");

    envAudit = await auditEnv({
      code: opts.code,
      timeoutMs: opts.timeoutMs,
      backend,
    });
  } catch {
    /* 审计失败不阻塞侦察 */
  }

  const warnings: string[] = [];

  if (
    detection.obfuscatorIO &&
    detection.obfuscatorIO.stringArrayNames.length > 0 &&
    pool?.decoded !== true
  ) {
    warnings.push(
      "字符串池未解码为明文（双参 RC4 或解码器不可单参求值）——反混淆管线对池字符串的还原可能受限，见 pool(编码态)"
    );
  }

  return {
    accessMap: out.envAccesses,
    debugLog: out.debugLog,
    family: detection.family,
    confidence: detection.confidence,
    features: detection.features,
    run: {
      ok: out.ok,
      ret: out.ret,
      thrown: out.thrown,
      console: out.console,
      storage: out.storage,
      netLog: out.netLog ?? [],
      netMisses: out.netMisses ?? [],
      envMisses: out.envMisses ?? {},
      evalLog: out.evalLog ?? [],
      consumed: out.consumed,
      flags: out.flags,
      gasUsed: out.gasUsed,
    },
    envAudit,
    warnings,
    missingEnv,
    pool,
  };
};
