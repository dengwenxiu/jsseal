/**
 * 环境审计器：把认知库条目编译成一段 JS，在封闭运行时内求值。
 *
 * 输出与 envMisses 互补：
 * - envMisses：样本执行时**摸到了什么缺**（样本驱动，事后）
 * - envAudit：环境本身**对不对**（认知驱动，事前/事后皆可）
 */

import { runSealed } from "@jsseal/runtime";
import type { BackendKind, SealedOutput } from "@jsseal/runtime";

import { KNOWLEDGE } from "./knowledge";
import type { EnvCheck, Severity } from "./knowledge";

export type AuditKind = "aligned" | "mismatch" | "error";

export interface AuditFailure {
  id: string;
  category: EnvCheck["category"];
  severity: Severity;
  desc: string;
  kind: "mismatch" | "error";
}

export interface AuditReport {
  total: number;
  aligned: number;
  mismatch: number;
  error: number;
  /** 按泄漏风险分级的缺口计数（维护优先级：先修 high） */
  highOpen: number;
  mediumOpen: number;
  lowOpen: number;
  failures: AuditFailure[];
}

export interface AuditOptions {
  /** 附加宿主代码（样本）：审计在样本执行后进行——测的是风控实际看到的环境 */
  code?: string;
  backend?: BackendKind;
  timeoutMs?: number;
  memoryLimitBytes?: number;
}

/** JSON 可表达的值——审计载荷的值域（封闭运行时把求值结果 JSON 化后回传） */
type AuditPayloadValue =
  | boolean
  | string
  | number
  | null
  | AuditPayloadValue[]
  | { [key: string]: AuditPayloadValue };

/** 审计载荷：认知 id → 求值结果（true=对齐；'ERROR'=表达式抛错；其余=形态不匹配） */
type AuditPayload = Record<string, AuditPayloadValue>;

/** 泄漏风险分级 → 缺口计数键 */
const OPEN_COUNT_KEY = {
  high: "highOpen",
  medium: "mediumOpen",
  low: "lowOpen",
} as const;

/** 载荷顶层必为对象（buildAuditCode 产出 `JSON.stringify(对象)`） */
const isAuditPayload = (value: unknown): value is AuditPayload =>
  value !== null && value === Object(value);

/** 审计代码生成：每条独立 try（单条抛错不影响其余） */
const buildAuditCode = (): string => {
  const lines = KNOWLEDGE.map(
    (k) =>
      `try { __env[${JSON.stringify(k.id)}] = (function(){ return (${k.expr}); })(); } catch (e) { __env[${JSON.stringify(k.id)}] = 'ERROR'; }`
  );

  return `var __env = {};\n${lines.join("\n")}\nglobalThis.__jsseal_ret_raw = JSON.stringify(__env);`;
};

/** 载荷解析：解析失败即无法判定任何条目；非对象载荷（被样本改写）按空载荷处理 */
const parseAuditPayload = (raw: string): AuditPayload => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("env audit result parse failed");
  }

  return isAuditPayload(parsed) ? parsed : {};
};

/** 认知库逐条比对：只有 true 算对齐，'ERROR' 是表达式抛错，其余都是形态不匹配 */
const tallyFailures = (values: AuditPayload): Omit<AuditReport, "total"> => {
  const failures: AuditFailure[] = [];

  const tally = {
    aligned: 0,
    mismatch: 0,
    error: 0,
    highOpen: 0,
    mediumOpen: 0,
    lowOpen: 0,
  };

  for (const k of KNOWLEDGE) {
    const v = values[k.id];

    if (v === true) {
      tally.aligned += 1;
      continue;
    }

    const kind: AuditFailure["kind"] = v === "ERROR" ? "error" : "mismatch";

    tally[kind] += 1;
    tally[OPEN_COUNT_KEY[k.severity]] += 1;
    failures.push({
      id: k.id,
      category: k.category,
      severity: k.severity,
      desc: k.desc,
      kind,
    });
  }

  return { ...tally, failures };
};

export const auditEnv = async (
  opts: AuditOptions = {}
): Promise<AuditReport> => {
  const auditCode = buildAuditCode();
  const hostCode = opts.code ?? "";
  const code = hostCode === "" ? auditCode : `${hostCode}\n;\n${auditCode}`;
  let out: SealedOutput;

  try {
    out = await runSealed({
      code,
      mode: "record",
      backend: opts.backend ?? "quickjs",
      timeoutMs: opts.timeoutMs,
      memoryLimitBytes: opts.memoryLimitBytes,
    });
  } catch (runError) {
    const message =
      runError instanceof Error ? runError.message : String(runError);

    throw new Error(`env audit run failed: ${message}`, { cause: runError });
  }

  const ret = out.ret ?? "";

  if (!out.ok && ret === "") {
    throw new Error(`env audit run failed: ${out.thrown ?? "unknown"}`);
  }

  return { total: KNOWLEDGE.length, ...tallyFailures(parseAuditPayload(ret)) };
};
