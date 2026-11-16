#!/usr/bin/env node
/**
 * jsseal — 确定性封闭运行时 JS 反混淆器
 *
 * 用法：
 *   `jsseal <input.js> [options]`
 *     `-o, --out <file>`       输出文件（默认 `<input>.deobf.js`）
 *     `--entry <name>`         入口函数名（模式②：参数钉死）
 *     `--args <json>`          入口参数（JSON 数组）
 *     `--samples <n>`          锚点采样数（默认 3）
 *     `--max-rounds <n>`       变换轮数上限（默认 6）
 *     `--backend <kind>`       quickjs | nodevm
 *     `--timeout <ms>`         单次执行超时
 *     `--report <file>`        报告 JSON 输出路径
 *     `--detect-only`          只做识别 + 封闭诊断，不变换
 *     `--json`                 机器可读输出（最终报告到 stdout）
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { deobfuscate } from "@jsseal/core";
import type { DeobfuscateReport, ProbeReport } from "@jsseal/core";

interface NetFixture {
  status?: number;
  body?: string;
}

interface CliArgs {
  input?: string;
  out?: string;
  entry?: string;
  args?: string;
  samples?: number;
  maxRounds?: number;
  backend?: "quickjs" | "nodevm";
  timeout?: number;
  report?: string;
  detectOnly?: boolean;
  json?: boolean;
  netFixtures?: Record<string, NetFixture>;
  forcedBranches?: number;
}

interface EntryPin {
  name: string;
  args: unknown[];
}

interface ProbeOptions {
  entry?: EntryPin;
  fixtures: Record<string, NetFixture>;
  timeout?: number;
  json: boolean;
}

interface NetFixtureArg {
  url: string;
  fixture: NetFixture;
}

const HELP_TEXT = [
  "jsseal — deterministic sealed-runtime JS deobfuscator",
  "",
  "usage: jsseal <input.js> [options]",
  "  -o, --out <file>       output file (STRONGLY recommended: default <input>.deobf.js",
  "                         writes next to the input and pollutes the sample dir)",
  "  --entry <name>         entry function name (mode 2: pinned args)",
  "  --args <json>          entry args (JSON array)",
  "  --samples <n>          anchor samples (default 3)",
  "  --max-rounds <n>       transform round limit (default 6)",
  "  --net-fixture <u=v>    network fixture, u=body or u=status::body (repeatable)",
  "  --forced-branches <n>  forced-execution anchors (default 0=off; VALIDATION ONLY,",
  "                         does NOT improve deobfuscation; ~2x runtime)",
  "  --backend <kind>       quickjs | nodevm (native is default when available)",
  "  --timeout <ms>         per-exec timeout",
  "  --report <file>        write JSON report",
  "  --detect-only          detection + sealing diagnostics only",
  "  --json                 machine-readable report to stdout",
  "",
  "  probe <input.js>       recon mode: sealed run + full-dimension report",
  "                         (options: --entry/--args/--net-fixture/--timeout/--json)",
  "",
  "exit codes: 0=ok, 2=usage error, 3=final validation FAILED (report still written)",
  "NOTE: final check PASS means behavior-identical, NOT fully deobfuscated.",
  "      Check WARNING lines and pool coverage to assess deobfuscation quality.",
  "",
].join("\n");

/** CLI 里大量「有值才生效」的可选字符串：显式判空（strict-boolean-expressions）。 */
const hasText = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value !== "";

/** 计数表取前 n 项（降序，等值保持插入序）；ES2022 lib 无 `Array#toSorted`。 */
const topEntries = (
  counts: Record<string, number>,
  limit: number
): [string, number][] => {
  const top: [string, number][] = [];

  for (const [key, count] of Object.entries(counts)) {
    const insertAt = top.findIndex(([, value]) => value < count);

    if (insertAt === -1) {
      top.push([key, count]);
    } else {
      top.splice(insertAt, 0, [key, count]);
    }

    if (top.length > limit) {
      top.pop();
    }
  }

  return top;
};

/** `key×count, key×count` 形式的摘要（空表回退 `(none)`）。 */
const formatCountPairs = (counts: Record<string, number>): string => {
  const pairs = topEntries(counts, 8)
    .map(([key, count]) => `${key}×${count}`)
    .join(", ");

  return pairs || "(none)";
};

/** 主命令 `--net-fixture`：status 只认 `=` 右侧取值段的起始 `::` 前缀。 */
const parseNetFixture = (raw: string): NetFixtureArg | undefined => {
  const eq = raw.indexOf("=");

  if (eq <= 0) {
    return undefined;
  }

  const url = raw.slice(0, eq);
  const value = raw.slice(eq + 1);
  const sep = value.indexOf("::");
  const statusText = sep > 0 ? value.slice(0, sep) : "";

  if (/^\d+$/u.test(statusText)) {
    return {
      url,
      fixture: { status: Number(statusText), body: value.slice(sep + 2) },
    };
  }

  return { url, fixture: { body: value } };
};

/** probe 的既有实现按整串扫描 `::`（先于 `=` 出现时不识别 status），行为保持不变。 */
const parseProbeNetFixture = (raw: string): NetFixtureArg | undefined => {
  const eq = raw.indexOf("=");

  if (eq <= 0) {
    return undefined;
  }

  const url = raw.slice(0, eq);
  const sep = raw.indexOf("::");
  const statusText = sep > 0 ? raw.slice(eq + 1, sep) : "";

  if (/^\d+$/u.test(statusText)) {
    return {
      url,
      fixture: { status: Number(statusText), body: raw.slice(sep + 2) },
    };
  }

  return { url, fixture: { body: raw.slice(eq + 1) } };
};

const parseArgv = (argv: string[]): CliArgs => {
  const args: CliArgs = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];

    const takeValue = (): string => {
      i += 1;
      const v = argv[i];

      if (v === undefined) {
        process.stderr.write(`missing value for ${a}\n`);
        process.exit(2);
      }

      return v;
    };

    switch (a) {
      case "-o":
      case "--out": {
        args.out = takeValue();
        break;
      }

      case "--entry": {
        args.entry = takeValue();
        break;
      }

      case "--args": {
        args.args = takeValue();
        break;
      }

      case "--samples": {
        args.samples = Number(takeValue());
        break;
      }

      case "--max-rounds": {
        args.maxRounds = Number(takeValue());
        break;
      }

      case "--forced-branches": {
        args.forcedBranches = Number(takeValue());
        break;
      }

      case "--backend": {
        // SAFETY: 取值原样透传给 core；非法 backend 由运行时后端选择处回退（既有行为），CLI 不做取值校验
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- `as` 仅让 string 匹配 BackendKind 联合；取值校验不在 CLI 层（见上）
        args.backend = takeValue() as "quickjs" | "nodevm";
        break;
      }

      case "--timeout": {
        args.timeout = Number(takeValue());
        break;
      }

      case "--report": {
        args.report = takeValue();
        break;
      }

      case "--net-fixture": {
        args.netFixtures ??= {};

        // 形如 url=status:body 或 url=body
        const parsed = parseNetFixture(takeValue());

        if (parsed !== undefined) {
          args.netFixtures[parsed.url] = parsed.fixture;
        }

        break;
      }

      case "--detect-only": {
        args.detectOnly = true;
        break;
      }

      case "--json": {
        args.json = true;
        break;
      }

      case "-h":
      case "--help": {
        process.stdout.write(HELP_TEXT);
        process.exit(0);
        break;
      }

      default: {
        if (a.startsWith("-")) {
          process.stderr.write(`unknown option: ${a}\n`);
          process.exit(2);
        }

        positional.push(a);
      }
    }
  }

  const [input] = positional;

  args.input = input;

  return args;
};

const parseProbeOptions = (rest: string[]): ProbeOptions => {
  let entryName: string | undefined;
  let entryArgs: unknown[] = [];
  const fixtures: Record<string, NetFixture> = {};
  let timeout: number | undefined;
  let json = false;

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];

    const takeValue = (): string => {
      i += 1;

      return rest[i];
    };

    switch (a) {
      case "--entry": {
        entryName = takeValue();
        break;
      }

      case "--args": {
        // SAFETY: --args 按契约是 JSON 数组；元素类型由入口函数自行约束
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse 返回 any，CLI 不校验元素类型（既有行为）
        entryArgs = JSON.parse(takeValue()) as unknown[];
        break;
      }

      case "--timeout": {
        timeout = Number(takeValue());
        break;
      }

      case "--json": {
        json = true;
        break;
      }

      case "--net-fixture": {
        const parsed = parseProbeNetFixture(takeValue());

        if (parsed !== undefined) {
          fixtures[parsed.url] = parsed.fixture;
        }

        break;
      }

      default: {
        // 未知参数静默忽略：probe 只认自己的开关（既有行为）
        break;
      }
    }
  }

  return {
    entry: hasText(entryName)
      ? { name: entryName, args: entryArgs }
      : undefined,
    fixtures,
    timeout,
    json,
  };
};

const formatProbeRunLine = (run: ProbeReport["run"]): string => {
  const thrownSuffix = hasText(run.thrown)
    ? ` thrown=${run.thrown.slice(0, 80)}`
    : "";

  return `run:           ok=${run.ok}${thrownSuffix}`;
};

const formatConsoleLines = (run: ProbeReport["run"]): string[] => {
  if (run.console.length === 0) {
    return [];
  }

  const entries = run.console
    .slice(0, 10)
    .map((entry) => `  [${entry.level}] ${entry.text.slice(0, 120)}`);

  return [`console (${run.console.length}):`, ...entries];
};

const formatEvalLogLines = (run: ProbeReport["run"]): string[] => {
  if (run.evalLog.length === 0) {
    return [];
  }

  const entries = run.evalLog
    .slice(0, 5)
    .map((snippet) => `  ${JSON.stringify(snippet.slice(0, 160))}`);

  return [`eval/Function 生成码 (${run.evalLog.length}):`, ...entries];
};

const formatNetLogLines = (run: ProbeReport["run"]): string[] => {
  if (run.netLog.length === 0) {
    return [];
  }

  const entries = run.netLog.slice(0, 8).map((request) => {
    const bodySuffix = hasText(request.body)
      ? ` body=${request.body.slice(0, 60)}`
      : "";

    return `  ${request.method} ${request.url.slice(0, 100)}${bodySuffix}`;
  });

  return [`网络请求 (${run.netLog.length}):`, ...entries];
};

const formatNetMissesLine = (run: ProbeReport["run"]): string[] => {
  if (run.netMisses.length === 0) {
    return [];
  }

  return [`缺流量 fixture:  ${run.netMisses.slice(0, 5).join(", ")}`];
};

const formatEnvMissesLine = (run: ProbeReport["run"]): string[] => {
  if (Object.keys(run.envMisses).length === 0) {
    return [];
  }

  const pairs = topEntries(run.envMisses, 10)
    .map(([key, count]) => `${key}×${count}`)
    .join(", ");

  return [`缺环境 API:      ${pairs}`];
};

const formatStorageLine = (run: ProbeReport["run"]): string[] => {
  if (Object.keys(run.storage).length === 0) {
    return [];
  }

  return [`storage 写入:    ${JSON.stringify(run.storage).slice(0, 160)}`];
};

const formatWarningLines = (warnings: string[]): string[] => {
  if (warnings.length === 0) {
    return [];
  }

  return ["警告:", ...warnings.map((warning) => `  ! ${warning}`)];
};

const formatPoolLines = (pool: ProbeReport["pool"]): string[] => {
  if (pool === undefined || pool.items.length === 0) {
    return [];
  }

  const poolState = pool.decoded ? "解码明文" : "编码态（未解码）";

  const items = pool.items
    .slice(0, 15)
    .map((item) => `  ${JSON.stringify(item.slice(0, 80))}`);

  return [`字符串池 (${pool.items.length}, ${poolState}):`, ...items];
};

const buildProbeLines = (report: ProbeReport): string[] => [
  `family:        ${report.family} (confidence ${report.confidence})`,
  `features:      ${report.features.slice(0, 6).join(", ")}`,
  formatProbeRunLine(report.run),
  `seeds:         ${JSON.stringify(report.run.consumed)} gas=${report.run.gasUsed ?? "-"} flags=${JSON.stringify(report.run.flags)}`,
  ...formatConsoleLines(report.run),
  ...formatEvalLogLines(report.run),
  ...formatNetLogLines(report.run),
  ...formatNetMissesLine(report.run),
  ...formatEnvMissesLine(report.run),
  ...formatStorageLine(report.run),
  ...formatWarningLines(report.warnings),
  ...formatPoolLines(report.pool),
];

/** probe 的即时输出通道（先于汇总行写出，保持既有顺序）。 */
const writeProbeSideChannels = (report: ProbeReport): void => {
  const { accessMap, debugLog, envAudit } = report;

  if (accessMap !== undefined && Object.keys(accessMap).length > 0) {
    const entries = topEntries(accessMap, 8)
      .map(([key, count]) => `${key}×${count}`)
      .join("  ");

    process.stdout.write(`访问图谱 (top8): ${entries}\n`);
  }

  if (debugLog !== undefined && debugLog.length > 0) {
    process.stdout.write(`插桩输出 (${debugLog.length}):\n`);

    for (const line of debugLog.slice(0, 10)) {
      process.stdout.write(`  [dbg] ${line}\n`);
    }
  }

  if (envAudit !== undefined) {
    const firstFailure =
      envAudit.failures.length > 0 ? ` — 首个: ${envAudit.failures[0].id}` : "";

    process.stdout.write(
      `环境审计: 对齐 ${envAudit.aligned}/${envAudit.total}（缺口 high=${envAudit.highOpen} medium=${envAudit.mediumOpen}）${firstFailure}\n`
    );
  }
};

const probeMain = async (input: string, rest: string[]): Promise<void> => {
  const { probe } = await import("@jsseal/core");
  const options = parseProbeOptions(rest);
  const code = readFileSync(path.resolve(input), "utf-8");

  const report = await probe({
    code,
    entry: options.entry,
    netFixtures: options.fixtures,
    timeoutMs: options.timeout,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2));

    return;
  }

  writeProbeSideChannels(report);
  process.stdout.write(`${buildProbeLines(report).join("\n")}\n`);
};

const envAuditMain = async (input: string, json: boolean): Promise<void> => {
  const { auditEnv } = await import("@jsseal/env-kit");

  const audit = await auditEnv({
    code: readFileSync(input, "utf-8"),
    backend: "native",
  });

  if (json) {
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);

    return;
  }

  process.stdout.write("=== 环境审计（认知库对齐）===\n");
  process.stdout.write(
    `对齐: ${audit.aligned}/${audit.total}  缺口: high=${audit.highOpen} medium=${audit.mediumOpen} low=${audit.lowOpen}\n`
  );

  for (const failure of audit.failures) {
    process.stdout.write(
      `  [${failure.severity}][${failure.kind}] ${failure.id} — ${failure.desc}\n`
    );
  }

  if (audit.failures.length === 0) {
    process.stdout.write("  （认知库全量对齐）\n");
  }

  process.stdout.write(
    "认知库维护: packages/env-kit/src/knowledge.ts；真机采集: buildCaptureScript()\n"
  );
};

/** 子命令分发；返回 true 表示已处理，main 不再走主流程。 */
const runSubcommand = async (raw: string[]): Promise<boolean> => {
  if (raw[0] === "env-audit") {
    const [, input] = raw;

    if (!hasText(input)) {
      process.stderr.write("usage: jsseal env-audit <input.js> [--json]\n");
      process.exit(2);
    }

    await envAuditMain(input, raw.includes("--json"));

    return true;
  }

  if (raw[0] === "probe") {
    const [, input] = raw;

    if (!hasText(input)) {
      process.stderr.write(
        "usage: jsseal probe <input.js> [--entry name] [--args json] [--net-fixture u=v] [--json]\n"
      );
      process.exit(2);
    }

    await probeMain(input, raw.slice(2));

    return true;
  }

  return false;
};

const buildEntry = (args: CliArgs): EntryPin | undefined => {
  if (!hasText(args.entry)) {
    return undefined;
  }

  let entryArgs: unknown[] = [];

  if (hasText(args.args)) {
    try {
      // SAFETY: --args 按契约是 JSON 数组；元素类型由入口函数自行约束
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse 返回 any，CLI 不校验元素类型（既有行为）
      entryArgs = JSON.parse(args.args) as unknown[];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      process.stderr.write(`--args is not valid JSON: ${detail}\n`);
      process.exit(2);
    }
  }

  return { name: args.entry, args: entryArgs };
};

/** decoder-lookup-table 报告里的查表条数（notes 形如 `name:count`）。 */
const lookupTableEntryCounts = (
  applied: DeobfuscateReport["applied"]
): number[] =>
  applied
    .filter((record) => record.name === "decoder-lookup-table")
    .flatMap((record) => record.notes)
    .map((note) => /:(?<count>\d+)$/u.exec(note)?.groups?.count)
    .filter((raw): raw is string => raw !== undefined)
    .map(Number);

/** 还原度告警：PASS ≠ 还原成功（外部 Agent 实测教训）。 */
const collectQualityWarnings = (
  report: DeobfuscateReport,
  inputLength: number
): string[] => {
  const warnings: string[] = [];
  const plan = report.detection.obfuscatorIO;

  if (plan !== undefined && plan !== null && plan.stringArrayNames.length > 0) {
    const inlineApplied = report.applied.some(
      (record) => record.name === "inline-decoder"
    );

    const maxEntries = Math.max(0, ...lookupTableEntryCounts(report.applied));

    if (!inlineApplied && maxEntries < 8) {
      warnings.push(
        `字符串池还原度极低（查表仅 ${maxEntries} 条，池规模 ${plan.stringArrayNames.length} 个函数）——产物仍含大量编码字符串；多因 inline-decoder 被锚库回滚（解码器有轮转时序依赖），详见 report.rolledBack`
      );
    }
  }

  if (report.finalCode.length > inputLength * 1.2) {
    warnings.push(
      `产物比输入膨胀 ${Math.round((report.finalCode.length / inputLength - 1) * 100)}%（对未还原样本的格式化变换可能净收益为负）`
    );
  }

  return warnings;
};

const formatTransformRecords = (
  records: { name: string; round: number }[]
): string => {
  const joined = records
    .map((record) => `${record.name}@r${record.round}`)
    .join(", ");

  return joined || "(none)";
};

const describeFinalCheck = (
  validation: DeobfuscateReport["finalValidation"]
): string => {
  if (validation?.pass === true) {
    return "PASS — output behavior identical on all anchors";
  }

  if (validation?.skipped === true) {
    return "SKIPPED — no usable anchors";
  }

  return "FAIL";
};

const formatNetRequests = (netLog: DeobfuscateReport["netLog"]): string => {
  const count = netLog?.length ?? 0;

  if (count === 0) {
    return `${count}`;
  }

  const sample = netLog
    .slice(0, 3)
    .map(
      (request) =>
        `${request.method} ${request.url.slice(0, 48)}${request.url.length > 48 ? "…" : ""}`
    )
    .join(" | ");

  return `${count} — ${sample}`;
};

const buildSummaryLines = (
  report: DeobfuscateReport,
  outPath: string,
  inputLength: number,
  warnings: string[]
): string[] => {
  const degradedSuffix = report.corpus.degraded ? " [DEGRADED]" : "";

  const forcedSuffix = report.forcedAnchors
    ? ` (含 ${report.forcedAnchors} 个强制分支锚点)`
    : "";

  return [
    `family:        ${report.detection.family} (confidence ${report.detection.confidence})`,
    `backend:       ${report.backend ?? "-"}`,
    `features:      ${report.detection.features.slice(0, 6).join(", ")}`,
    `anchors:       ${report.corpus.samples} sample(s)${degradedSuffix}${forcedSuffix}`,
    `seal:          consumed=${JSON.stringify(report.sealOverview?.consumed ?? {})} flags=${JSON.stringify(report.sealOverview?.flags ?? {})}`,
    `rounds:        ${report.rounds}`,
    `applied:       ${formatTransformRecords(report.applied)}`,
    `rolled-back:   ${formatTransformRecords(report.rolledBack)}`,
    `final check:   ${describeFinalCheck(report.finalValidation)}`,
    `missing env:   ${Object.keys(report.missingEnv).slice(0, 10).join(", ") || "(none)"}`,
    `net requests:  ${formatNetRequests(report.netLog)}`,
    `net misses:    ${(report.netMisses ?? []).slice(0, 5).join(", ") || "(none)"}`,
    `env misses:    ${formatCountPairs(report.envMisses ?? {})}`,
    `output:        ${outPath}`,
    `input size:    ${inputLength} → output size: ${report.finalCode.length}`,
    ...warnings.map((warning) => `WARNING:       ${warning}`),
  ];
};

const main = async (): Promise<void> => {
  const raw = process.argv.slice(2);

  if (await runSubcommand(raw)) {
    return;
  }

  const args = parseArgv(raw);

  if (!hasText(args.input)) {
    process.stderr.write(
      "usage: jsseal <input.js> [options] | jsseal probe <input.js>  (--help for details)\n"
    );
    process.exit(2);
  }

  const inputPath = path.resolve(args.input);
  let code: string;

  try {
    code = readFileSync(inputPath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    process.stderr.write(`cannot read input: ${detail}\n`);
    process.exit(1);
  }

  const entry = buildEntry(args);

  const report = await deobfuscate({
    code,
    entry,
    netFixtures: args.netFixtures,
    forcedBranches: args.forcedBranches,
    samples: args.samples,
    maxRounds: args.maxRounds,
    backend: args.backend,
    timeoutMs: args.timeout,
    detectOnly: args.detectOnly,
  });

  const outPath = args.out ?? `${inputPath.replace(/\.js$/iu, "")}.deobf.js`;

  writeFileSync(outPath, report.finalCode);

  if (hasText(args.report)) {
    const { finalCode: _drop, ...reportWithoutCode } = report;

    writeFileSync(
      path.resolve(args.report),
      JSON.stringify(reportWithoutCode, null, 2)
    );
  }

  if (args.json === true) {
    process.stdout.write(JSON.stringify({ ...report, outPath }, null, 2));

    return;
  }

  const warnings = collectQualityWarnings(report, code.length);
  const lines = buildSummaryLines(report, outPath, code.length, warnings);

  process.stdout.write(`${lines.join("\n")}\n`);

  if (
    report.finalValidation?.pass !== true &&
    report.finalValidation?.skipped !== true
  ) {
    process.exitCode = 3;
  }
};

const run = async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    const detail =
      error instanceof Error ? (error.stack ?? String(error)) : String(error);

    process.stderr.write(`fatal: ${detail}\n`);
    process.exit(1);
  }
};

void run();
