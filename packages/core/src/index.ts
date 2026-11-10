/**
 * @jsseal/core — 渐进式反编排（governor）+ 管线编排
 *
 * 宪法执行处：每个变换提案（规则/未来 LLM）都必须在锚库上重放验证，
 * 通过才提交，失败即回滚；连续失败 2 次的变换对本文件禁用。
 * 锚库不可用（无法封闭）时拒绝变换，原样返回——没有验证锚点就没有变换。
 */

import { freeVariables, hashCode, parseCode, printCode, traverse } from '@jsseal/ast';
import { buildCorpus, validateCorpus, type Corpus, type ValidationOutcome } from '@jsseal/anchors';
import { detect, type Detection } from '@jsseal/detector';
import { defaultPipeline } from '@jsseal/transforms';
import type { Transform } from '@jsseal/transforms';
import { extractBranchFingerprints, buildMigration } from '@jsseal/transforms';
import { runSealed, type BackendKind, type EntrySpec, type FunctionPin } from '@jsseal/runtime';
import { isEngineAvailable } from '@jsseal/engine-native';
import * as t from '@babel/types';

export interface DeobfuscateOptions {
  code: string;
  entry?: EntrySpec;
  samples?: number;
  maxRounds?: number;
  backend?: BackendKind;
  /** 环境模板（透传封闭运行时） */
  env?: Record<string, unknown>;
  /** 网络 fixture（VCR，透传封闭运行时） */
  netFixtures?: Record<string, { status?: number; body?: string }>;
  /** forced execution 锚点数上限（native；0=关闭，默认 8）——多路径覆盖 */
  forcedBranches?: number;
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
  backend?: import('@jsseal/runtime').BackendKind;
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
  netLog: Array<{ method: string; url: string; body: string | null }>;
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

/**
 * 从原始代码构建 FunctionPin（toString 钉死数据源）。
 * 覆盖有推断名的函数：函数声明 / var 赋值 / 对象属性与原型方法赋值
 * （selfDefending 的检测函数通常挂在 prototype 方法上）。
 */
export function buildPins(code: string): FunctionPin[] {
  const pins: FunctionPin[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined, node: t.Node): void => {
    if (!name || seen.has(name)) return;
    if (node.start == null || node.end == null) return;
    seen.add(name);
    pins.push({ name, text: code.slice(node.start, node.end) });
  };
  try {
    const ast = parseCode(code);
    traverse(ast, {
      'FunctionDeclaration|VariableDeclarator|AssignmentExpression|ObjectProperty'(path) {
        const n = path.node;
        if (t.isFunctionDeclaration(n)) {
          push(n.id?.name, n);
        } else if (t.isVariableDeclarator(n) && t.isIdentifier(n.id)) {
          const init = n.init;
          if (init && t.isArrowFunctionExpression(init)) {
            push(n.id.name, n);
          } else if (init && t.isFunctionExpression(init)) {
            push(init.id ? init.id.name : n.id.name, n);
          }
        } else if (t.isAssignmentExpression(n) && t.isMemberExpression(n.left)) {
          const init = n.right;
          if (init && t.isFunctionExpression(init) && !init.id) {
            const key = n.left.property;
            const name = t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : undefined;
            push(name, n);
          }
        } else if (t.isObjectProperty(n)) {
          const v = n.value;
          const isFn =
            (v && t.isFunctionExpression(v) && !v.id) || (v && t.isArrowFunctionExpression(v));
          if (isFn) {
            const key = n.key;
            const name = t.isIdentifier(key) ? key.name : t.isStringLiteral(key) ? key.value : undefined;
            push(name, n);
          }
        }
      },
    });
  } catch {
    /* 解析失败返回空 pins */
  }
  return pins;
}

/** demangle 后同步 pins 键名（同名映射到多个新名 → 放弃该 pin，保守） */
function rekeyPins(pins: FunctionPin[], pairs: Array<{ from: string; to: string }>): FunctionPin[] {
  const map = new Map<string, string>();
  const froms = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!froms.has(p.from)) froms.set(p.from, new Set());
    froms.get(p.from)!.add(p.to);
  }
  for (const [from, tos] of froms) {
    if (tos.size === 1) map.set(from, [...tos][0]);
  }
  return pins
    .map((pin) => (map.has(pin.name) ? { name: map.get(pin.name)!, text: pin.text } : pin))
    .filter((pin) => pin.text.length > 0);
}

function summarizeValidation(v: ValidationOutcome): string {
  const f = v.failures[0];
  if (!f) return 'unknown';
  return `sample#${f.sample} ${f.kind}: ${f.detail.slice(0, 200)}`;
}

/** 默认后端：native 引擎可用则 native（主力），否则降级 quickjs(wasm) */
function defaultBackend(): BackendKind {
  try {
    return isEngineAvailable() ? 'native' : 'quickjs';
  } catch {
    return 'quickjs';
  }
}

export async function deobfuscate(opts: DeobfuscateOptions): Promise<DeobfuscateReport> {
  const backend = opts.backend ?? defaultBackend();
  const detection = detect(opts.code);
  const pipeline = opts.transforms ?? defaultPipeline;
  const maxRounds = opts.maxRounds ?? 6;

  // ---------- 阶段 B/C：环境封闭 + 采样造锚 ----------
  const corpus: Corpus = await buildCorpus({
    code: opts.code,
    samples: opts.samples ?? 3,
    entry: opts.entry,
    backend,
    timeoutMs: opts.timeoutMs,
    memoryLimitBytes: opts.memoryLimitBytes,
  });

  // ---------- forced execution：第 k 个执行的条件分支取反锚点（多路径覆盖） ----------
  let forcedAnchors = 0;
  const maxForced = backend === 'native' ? (opts.forcedBranches ?? 0) : 0; // 默认关闭：序号锚定在重度结构变换下会漂移（见 docs §17）
  if (maxForced > 0 && corpus.samples.length > 0) {
    const branchFps = extractBranchFingerprints(parseCode(opts.code));
    for (let k = 1; k <= maxForced; k++) {
      try {
        const run = await runSealed({
          code: opts.code,
          mode: 'record',
          entry: opts.entry,
          backend,
          timeoutMs: opts.timeoutMs,
          memoryLimitBytes: opts.memoryLimitBytes,
          forceBranchIndex: k,
          env: opts.env as never,
        });
        if (run.forceApplied && !run.flags.timeout && !run.flags.oom) {
          // 记录分支指纹（结构身份——k-1 因为 fps 是 0-based 而 forceIndex 是 1-based）
          const fp = branchFps[k - 1]?.hash;
          corpus.samples.push({ tapes: run.tapes, expected: run, forceIndex: k, forceFingerprint: fp });
          forcedAnchors++;
        }
      } catch {
        /* 序号 k 超出分支执行数则 forceApplied=false，自然跳过 */
      }
    }
  }

  // ---------- 环境探针 + 网络 VCR 日志：一次 record 运行收集 ----------
  let envMisses: Record<string, number> = {};
  let netLog: Array<{ method: string; url: string; body: string | null }> = [];
  let netMisses: string[] = [];
  try {
    const probe = await runSealed({
      code: opts.code,
      mode: 'record',
      entry: opts.entry,
      backend,
      timeoutMs: opts.timeoutMs,
      memoryLimitBytes: opts.memoryLimitBytes,
      envProbe: true,
      netFixtures: opts.netFixtures,
    });
    envMisses = probe.envMisses ?? {};
    netLog = probe.netLog ?? [];
    netMisses = probe.netMisses ?? [];
  } catch {
    /* 探测失败不阻断 */
  }

  const sealSample = corpus.samples[0]?.expected ?? null;
  let current = opts.code;
  const applied: AppliedRecord[] = [];
  const rolledBack: RollbackRecord[] = [];
  const disabled = new Map<string, number>();

  if (corpus.samples.length === 0 && !opts.forceWithoutAnchors) {
    // 宪法：没有锚点就没有变换
    const finalCode = opts.code;
    const missingEnv = missingEnvOf(finalCode);
    return {
      inputHash: hashCode(opts.code),
      outputHash: hashCode(finalCode),
      backend,
      detection,
      corpus: { samples: 0, degraded: true, notes: corpus.notes },
      rounds: 0,
      applied,
      rolledBack,
      finalCode,
      finalValidation: { pass: false, failures: [], checked: 0, skipped: true },
      missingEnv,
      envMisses,
      netLog,
      netMisses,
      forcedAnchors,
      sealOverview: sealSample
        ? {
            console: sealSample.console.length,
            storage: Object.keys(sealSample.storage).length,
            consumed: sealSample.consumed,
            flags: sealSample.flags,
          }
        : null,
    };
  }

  // ---------- 阶段 E/F：渐进变换（逐条锚库验证） ----------
  let pins = buildPins(opts.code);
  let rounds = 0;

  if (!opts.detectOnly) {
    outer: for (let round = 1; round <= maxRounds; round++) {
      rounds = round;
      let changedAny = false;
      for (const transform of pipeline) {
        const fails = disabled.get(transform.name) ?? 0;
        if (fails >= 2) continue;
        let ast;
        try {
          ast = parseCode(current);
        } catch (e) {
          rolledBack.push({ name: '(parse)', round, reason: (e as Error).message });
          break outer;
        }
        let res;
        try {
          res = await transform.run(ast, {
            code: current,
            detection,
            backend,
            timeoutMs: opts.timeoutMs,
            memoryLimitBytes: opts.memoryLimitBytes,
            corpus,
          });
        } catch (e) {
          rolledBack.push({ name: transform.name, round, reason: `threw: ${(e as Error).message}` });
          disabled.set(transform.name, fails + 1);
          continue;
        }
        if (!res.changed) continue;
        const candidate = printCode(ast);
        if (candidate === current) continue;

        // 强制锚点指纹存活检查：结构变换（死代码消除/CFF 还原）可能删除或移动分支，
        // 原序号不再可靠。用指纹检查分支是否仍存在：
        //   - 存在 → 用迁移后的新序号（buildMigration 自动映射）
        //   - 不存在 → 跳过该强制锚点（分支已被合法消除）
        let effectiveCorpus = corpus;
        const forcedSamples = corpus.samples.filter((s2) => s2.forceIndex !== undefined);
        if (forcedSamples.length > 0) {
          const origAst = parseCode(opts.code);
          const candidateAst = parseCode(candidate);
          const migration = buildMigration(origAst, candidateAst);
          const adjusted = corpus.samples.map((s2) => {
            if (s2.forceIndex === undefined) return s2;
            const newIndex = migration.mapping.get(s2.forceIndex);
            if (newIndex === undefined) return null; // 分支被消除
            return { ...s2, forceIndex: newIndex };
          }).filter((s2): s2 is NonNullable<typeof s2> => s2 !== null);
          effectiveCorpus = { ...corpus, samples: adjusted };
        }
        const v = await validateCorpus(effectiveCorpus, candidate, {
          pins,
          timeoutMs: opts.timeoutMs,
          memoryLimitBytes: opts.memoryLimitBytes,
        });
        if (v.pass) {
          current = candidate;
          changedAny = true;
          applied.push({ name: transform.name, round, notes: res.notes });
          if (res.renamePairs?.length) pins = rekeyPins(pins, res.renamePairs);
        } else {
          rolledBack.push({ name: transform.name, round, reason: summarizeValidation(v) });
          disabled.set(transform.name, fails + 1);
        }
      }
      if (!changedAny) break;
    }
  }

  // ---------- 终验 ----------
  const finalValidation =
    corpus.samples.length > 0
      ? await validateCorpus(corpus, current, { pins, timeoutMs: opts.timeoutMs })
      : { pass: false, failures: [], checked: 0, skipped: true };

  const missingEnv = missingEnvOf(current);
  return {
    inputHash: hashCode(opts.code),
    outputHash: hashCode(current),
    backend,
    detection,
    corpus: { samples: corpus.samples.length, degraded: corpus.degraded, notes: corpus.notes },
    rounds,
    applied,
    rolledBack,
    finalCode: current,
    finalValidation,
    missingEnv,
    envMisses,
    netLog,
    netMisses,
    forcedAnchors,
    sealOverview: sealSample
      ? {
          console: sealSample.console.length,
          storage: Object.keys(sealSample.storage).length,
          consumed: sealSample.consumed,
          flags: sealSample.flags,
        }
      : null,
  };
}

function missingEnvOf(code: string): Record<string, number> {
  try {
    return Object.fromEntries(freeVariables(parseCode(code)));
  } catch {
    return {};
  }
}

/** 便捷：只做检测与封闭诊断 */
export async function diagnose(opts: DeobfuscateOptions): Promise<DeobfuscateReport> {
  return deobfuscate({ ...opts, detectOnly: true });
}

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
    console: Array<{ level: string; text: string }>;
    storage: Record<string, string>;
    netLog: Array<{ method: string; url: string; body: string | null }>;
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
  envAudit?: import('@jsseal/env-kit').AuditReport;
  missingEnv: Record<string, number>;
  /** 还原度告警：验证 PASS 不代表还原成功（外部 Agent 实测教训） */
  warnings: string[];
}

/** 解码字符串池明文：按池长度定扫描区间对 decoder 求值；
 * 单参扫描失败（RC4 双参等）回退到池原始内容（编码态，仍具侦察价值） */
async function readPool(
  detection: Detection,
  backend: import('@jsseal/runtime').BackendKind,
  timeoutMs?: number,
): Promise<{ decoded: boolean; items: string[] } | undefined> {
  const plan = detection.obfuscatorIO;
  if (!plan || !plan.prologueSource) return undefined;

  const run = async (driver: string) => {
    const out = await runSealed({
      code: plan.prologueSource + '\n' + driver,
      mode: 'record',
      backend,
      timeoutMs,
    });
    if (out.flags.tapeExhausted || out.flags.timeout || out.flags.oom) return null;
    try {
      return JSON.parse(out.ret ?? 'null');
    } catch {
      return null;
    }
  };

  // 池长度（原始数组）
  const arrName = plan.stringArrayNames[0];
  let poolLen = 1024;
  if (arrName) {
    const raw = await run(
      `globalThis.__jsseal_ret_raw = JSON.stringify(typeof ${arrName} === 'function' ? ${arrName}() : null);`,
    );
    if (Array.isArray(raw)) poolLen = raw.length;
  }

  // decoder 扫描（单参；带 key 的 RC4 解码器此处会失败/产出乱码——decoded 标志区分）
  if (plan.decoderNames.length > 0) {
    const dec = plan.decoderNames[0];
    const scan = await run(`
var __out = [];
for (var __i = 0; __i < ${Math.min(poolLen + 1024, 65536)}; __i++) {
  try {
    var __v = globalThis[${JSON.stringify(dec)}](__i);
    if (typeof __v === 'string' && __v.length > 0) __out.push(__v);
  } catch (e) {}
}
globalThis.__jsseal_ret_raw = JSON.stringify({ n: __out.length, out: __out.slice(0, 512) });
`);
    if (scan && typeof scan.n === 'number' && scan.n >= Math.min(4, poolLen / 4)) {
      return { decoded: true, items: [...new Set(scan.out as string[])] };
    }
  }

  // 回退：原始池（编码态）
  if (arrName) {
    const raw = await run(
      `globalThis.__jsseal_ret_raw = JSON.stringify(typeof ${arrName} === 'function' ? ${arrName}() : null);`,
    );
    if (Array.isArray(raw) && raw.length > 0 && raw.every((x: unknown) => typeof x === 'string')) {
      return { decoded: false, items: (raw as string[]).slice(0, 512) };
    }
  }
  return undefined;
}

/** 侦察：安全封闭跑一遍样本，全维度报告（分析员工作流的第一步） */
export async function probe(opts: DeobfuscateOptions): Promise<ProbeReport> {
  const backend = opts.backend ?? defaultBackend();
  const detection = detect(opts.code);
  const out = await runSealed({
    code: opts.code,
    mode: 'record',
    entry: opts.entry,
    backend,
    timeoutMs: opts.timeoutMs,
    memoryLimitBytes: opts.memoryLimitBytes,
    envProbe: true,
    netFixtures: opts.netFixtures,
    env: opts.env as never,
  });
  const pool = await readPool(detection, backend, opts.timeoutMs);
  let missingEnv: Record<string, number> = {};
  try {
    missingEnv = Object.fromEntries(freeVariables(parseCode(opts.code)));
  } catch {
    /* ignore */
  }
  let envAudit: import('@jsseal/env-kit').AuditReport | undefined;
  try {
    const { auditEnv } = await import('@jsseal/env-kit');
    envAudit = await auditEnv({ code: opts.code, backend, timeoutMs: opts.timeoutMs });
  } catch {
    /* 审计失败不阻塞侦察 */
  }
  const warnings: string[] = [];
  if (detection.obfuscatorIO && detection.obfuscatorIO.stringArrayNames.length > 0 && !pool?.decoded) {
    warnings.push(
      '字符串池未解码为明文（双参 RC4 或解码器不可单参求值）——反混淆管线对池字符串的还原可能受限，见 pool(编码态)',
    );
  }

  return {
    envAudit,
    family: detection.family,
    confidence: detection.confidence,
    features: detection.features,
    warnings,
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
    pool,
    missingEnv,
  };
}
