#!/usr/bin/env node
/**
 * jsseal — 确定性封闭运行时 JS 反混淆器
 *
 * 用法：
 *   jsseal <input.js> [options]
 *     -o, --out <file>       输出文件（默认 <input>.deobf.js）
 *     --entry <name>         入口函数名（模式②：参数钉死）
 *     --args <json>          入口参数（JSON 数组）
 *     --samples <n>          锚点采样数（默认 3）
 *     --max-rounds <n>       变换轮数上限（默认 6）
 *     --backend <kind>       quickjs | nodevm
 *     --timeout <ms>         单次执行超时
 *     --report <file>        报告 JSON 输出路径
 *     --detect-only          只做识别 + 封闭诊断，不变换
 *     --json                 机器可读输出（最终报告到 stdout）
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deobfuscate } from '@jsseal/core';

interface CliArgs {
  input?: string;
  out?: string;
  entry?: string;
  args?: string;
  samples?: number;
  maxRounds?: number;
  backend?: 'quickjs' | 'nodevm';
  timeout?: number;
  report?: string;
  detectOnly?: boolean;
  json?: boolean;
  netFixtures?: Record<string, { status?: number; body?: string }>;
  forcedBranches?: number;
}

function parseArgv(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write(`missing value for ${a}\n`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case '-o':
      case '--out':
        args.out = next();
        break;
      case '--entry':
        args.entry = next();
        break;
      case '--args':
        args.args = next();
        break;
      case '--samples':
        args.samples = Number(next());
        break;
      case '--max-rounds':
        args.maxRounds = Number(next());
        break;
      case '--forced-branches':
        args.forcedBranches = Number(next());
        break;
      case '--backend':
        args.backend = next() as 'quickjs' | 'nodevm';
        break;
      case '--timeout':
        args.timeout = Number(next());
        break;
      case '--report':
        args.report = next();
        break;
      case '--net-fixture':
        args.netFixtures = args.netFixtures ?? {};
        {
          const v = next(); // 形如 url=status:body 或 url=body
          const eq = v.indexOf('=');
          if (eq > 0) {
            const url = v.slice(0, eq);
            const val = v.slice(eq + 1);
            const sep = val.indexOf('::');
            if (sep > 0 && /^\d+$/.test(val.slice(0, sep))) {
              args.netFixtures[url] = { status: Number(val.slice(0, sep)), body: val.slice(sep + 2) };
            } else {
              args.netFixtures[url] = { body: val };
            }
          }
        }
        break;
      case '--detect-only':
        args.detectOnly = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '-h':
      case '--help':
        process.stdout.write(
          ['jsseal — deterministic sealed-runtime JS deobfuscator', '', 'usage: jsseal <input.js> [options]', ''].join('\n') +
            '  -o, --out <file>       output file (STRONGLY recommended: default <input>.deobf.js\n' +
            '                         writes next to the input and pollutes the sample dir)\n' +
            '  --entry <name>         entry function name (mode 2: pinned args)\n' +
            '  --args <json>          entry args (JSON array)\n' +
            '  --samples <n>          anchor samples (default 3)\n' +
            '  --max-rounds <n>       transform round limit (default 6)\n' +
            '  --net-fixture <u=v>    network fixture, u=body or u=status::body (repeatable)\n' +
            '  --forced-branches <n>  forced-execution anchors (default 0=off; VALIDATION ONLY,\n' +
            '                         does NOT improve deobfuscation; ~2x runtime)\n' +
            '  --backend <kind>       quickjs | nodevm (native is default when available)\n' +
            '  --timeout <ms>         per-exec timeout\n' +
            '  --report <file>        write JSON report\n' +
            '  --detect-only          detection + sealing diagnostics only\n' +
            '  --json                 machine-readable report to stdout\n' +
            '\n' +
            '  probe <input.js>       recon mode: sealed run + full-dimension report\n' +
            '                         (options: --entry/--args/--net-fixture/--timeout/--json)\n' +
            '\n' +
            'exit codes: 0=ok, 2=usage error, 3=final validation FAILED (report still written)\n' +
            'NOTE: final check PASS means behavior-identical, NOT fully deobfuscated.\n' +
            '      Check WARNING lines and pool coverage to assess deobfuscation quality.\n',
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith('-')) {
          process.stderr.write(`unknown option: ${a}\n`);
          process.exit(2);
        }
        positional.push(a);
    }
  }
  args.input = positional[0];
  return args;
}

async function probeMain(input: string, rest: string[]): Promise<void> {
  const { probe } = await import('@jsseal/core');
  let entryName: string | undefined;
  let entryArgs: unknown[] = [];
  let fixtures: Record<string, { status?: number; body?: string }> = {};
  let timeout: number | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = (): string => rest[++i];
    if (a === '--entry') entryName = next();
    else if (a === '--args') entryArgs = JSON.parse(next());
    else if (a === '--timeout') timeout = Number(next());
    else if (a === '--json') json = true;
    else if (a === '--net-fixture') {
      const v = next();
      const eq = v.indexOf('=');
      if (eq > 0) {
        const sep = v.indexOf('::');
        if (sep > 0 && /^\d+$/.test(v.slice(eq + 1, sep))) {
          fixtures[v.slice(0, eq)] = { status: Number(v.slice(eq + 1, sep)), body: v.slice(sep + 2) };
        } else {
          fixtures[v.slice(0, eq)] = { body: v.slice(eq + 1) };
        }
      }
    }
  }
  const code = readFileSync(resolve(input), 'utf8');
  const r = await probe({
    code,
    entry: entryName ? { name: entryName, args: entryArgs } : undefined,
    netFixtures: fixtures,
    timeoutMs: timeout,
  });
  if (json) {
    process.stdout.write(JSON.stringify(r, null, 2));
    return;
  }
  const L: string[] = [];
  L.push(`family:        ${r.family} (confidence ${r.confidence})`);
  L.push(`features:      ${r.features.slice(0, 6).join(', ')}`);
  L.push(`run:           ok=${r.run.ok}${r.run.thrown ? ` thrown=${r.run.thrown.slice(0, 80)}` : ''}`);
  L.push(`seeds:         ${JSON.stringify(r.run.consumed)} gas=${r.run.gasUsed ?? '-'} flags=${JSON.stringify(r.run.flags)}`);
  if (r.run.console.length) {
    L.push(`console (${r.run.console.length}):`);
    for (const c of r.run.console.slice(0, 10)) L.push(`  [${c.level}] ${c.text.slice(0, 120)}`);
  }
  if (r.run.evalLog.length) {
    L.push(`eval/Function 生成码 (${r.run.evalLog.length}):`);
    for (const e of r.run.evalLog.slice(0, 5)) L.push(`  ${JSON.stringify(e.slice(0, 160))}`);
  }
  if (r.run.netLog.length) {
    L.push(`网络请求 (${r.run.netLog.length}):`);
    for (const n of r.run.netLog.slice(0, 8)) L.push(`  ${n.method} ${n.url.slice(0, 100)}${n.body ? ' body=' + n.body.slice(0, 60) : ''}`);
  }
  if (r.run.netMisses.length) L.push(`缺流量 fixture:  ${r.run.netMisses.slice(0, 5).join(', ')}`);
  const envMiss = Object.entries(r.run.envMisses).sort((a, b) => b[1] - a[1]);
  if (envMiss.length) L.push(`缺环境 API:      ${envMiss.slice(0, 10).map(([k, n]) => `${k}×${n}`).join(', ')}`);
  if (Object.keys(r.run.storage).length) L.push(`storage 写入:    ${JSON.stringify(r.run.storage).slice(0, 160)}`);
  if (r.warnings.length) {
    L.push('警告:');
    for (const w of r.warnings) L.push(`  ! ${w}`);
  }
  if (r.pool && r.pool.items.length) {
    L.push(`字符串池 (${r.pool.items.length}, ${r.pool.decoded ? '解码明文' : '编码态（未解码）'}):`);
    for (const s2 of r.pool.items.slice(0, 15)) L.push(`  ${JSON.stringify(s2.slice(0, 80))}`);
  }
  process.stdout.write(L.join('\n') + '\n');
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw[0] === 'probe') {
    if (!raw[1]) {
      process.stderr.write('usage: jsseal probe <input.js> [--entry name] [--args json] [--net-fixture u=v] [--json]\n');
      process.exit(2);
    }
    await probeMain(raw[1], raw.slice(2));
    return;
  }
  const args = parseArgv(raw);
  if (!args.input) {
    process.stderr.write('usage: jsseal <input.js> [options] | jsseal probe <input.js>  (--help for details)\n');
    process.exit(2);
  }

  const inputPath = resolve(args.input);
  let code: string;
  try {
    code = readFileSync(inputPath, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read input: ${(e as Error).message}\n`);
    process.exit(1);
  }

  let entry;
  if (args.entry) {
    let entryArgs: unknown[] = [];
    if (args.args) {
      try {
        entryArgs = JSON.parse(args.args);
      } catch (e) {
        process.stderr.write(`--args is not valid JSON: ${(e as Error).message}\n`);
        process.exit(2);
      }
    }
    entry = { name: args.entry, args: entryArgs };
  }

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

  const outPath = args.out ?? inputPath.replace(/\.js$/i, '') + '.deobf.js';
  writeFileSync(outPath, report.finalCode);

  if (args.report) {
    const { finalCode: _drop, ...reportWithoutCode } = report;
    writeFileSync(resolve(args.report), JSON.stringify(reportWithoutCode, null, 2));
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ ...report, outPath }, null, 2));
    return;
  }

  // 还原度告警：PASS ≠ 还原成功（外部 Agent 实测教训）
  const warnings: string[] = [];
  const plan = report.detection.obfuscatorIO;
  if (plan && plan.stringArrayNames.length > 0) {
    const inlineApplied = report.applied.some((a) => a.name === 'inline-decoder');
    const ltEntry = report.applied
      .filter((a) => a.name === 'decoder-lookup-table')
      .flatMap((a) => a.notes)
      .map((n) => /:(\d+)$/.exec(n)?.[1])
      .filter((x): x is string => x != null)
      .map(Number);
    const maxEntries = Math.max(0, ...ltEntry);
    if (!inlineApplied && maxEntries < 8) {
      warnings.push(
        `字符串池还原度极低（查表仅 ${maxEntries} 条，池规模 ${plan.stringArrayNames.length} 个函数）——产物仍含大量编码字符串；多因 inline-decoder 被锚库回滚（解码器有轮转时序依赖），详见 report.rolledBack`,
      );
    }
  }
  if (report.finalCode.length > code.length * 1.2) {
    warnings.push(`产物比输入膨胀 ${Math.round((report.finalCode.length / code.length - 1) * 100)}%（对未还原样本的格式化变换可能净收益为负）`);
  }

  const lines = [
    `family:        ${report.detection.family} (confidence ${report.detection.confidence})`,
    `backend:       ${report.backend ?? '-'}`,
    `features:      ${report.detection.features.slice(0, 6).join(', ')}`,
    `anchors:       ${report.corpus.samples} sample(s)${report.corpus.degraded ? ' [DEGRADED]' : ''}${report.forcedAnchors ? ` (含 ${report.forcedAnchors} 个强制分支锚点)` : ''}`,
    `seal:          consumed=${JSON.stringify(report.sealOverview?.consumed ?? {})} flags=${JSON.stringify(report.sealOverview?.flags ?? {})}`,
    `rounds:        ${report.rounds}`,
    `applied:       ${report.applied.map((a: { name: string; round: number }) => `${a.name}@r${a.round}`).join(', ') || '(none)'}`,
    `rolled-back:   ${report.rolledBack.map((a: { name: string; round: number }) => `${a.name}@r${a.round}`).join(', ') || '(none)'}`,
    `final check:   ${report.finalValidation?.pass === true ? 'PASS — output behavior identical on all anchors' : report.finalValidation?.skipped ? 'SKIPPED — no usable anchors' : 'FAIL'}`,
    `missing env:   ${Object.keys(report.missingEnv).slice(0, 10).join(', ') || '(none)'}`,
    `net requests:  ${report.netLog?.length ?? 0}${report.netLog?.length ? ' — ' + report.netLog.slice(0, 3).map((r) => `${r.method} ${r.url.slice(0, 48)}${r.url.length > 48 ? '…' : ''}`).join(' | ') : ''}`,
    `net misses:    ${(report.netMisses ?? []).slice(0, 5).join(', ') || '(none)'}`,
    `env misses:    ${Object.entries(report.envMisses ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, n]) => `${k}×${n}`)
      .join(', ') || '(none)'}`,
    `output:        ${outPath}`,
    `input size:    ${code.length} → output size: ${report.finalCode.length}`,
    ...warnings.map((w) => `WARNING:       ${w}`),
  ];
  process.stdout.write(lines.join('\n') + '\n');

  if (report.finalValidation?.pass !== true && !report.finalValidation?.skipped) {
    process.exitCode = 3;
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.stack ?? e}\n`);
  process.exit(1);
});
