/**
 * jsseal playground 入口：浏览器内 wasm 后端跑完整管线（反混淆/侦察）。
 * @jsseal/core 无 Node 依赖，quickjs-emscripten 的 wasm 内嵌在 bundle 里。
 */
import { deobfuscate, probe } from '@jsseal/core';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = $('input') as HTMLTextAreaElement;
const status = $('status');
const outCode = $('out-code');
const outTrace = $('out-trace');
const outReport = $('out-report');
const btnRun = $('run') as HTMLButtonElement;
const btnProbe = $('probe') as HTMLButtonElement;

// ---------- tabs ----------
for (const btn of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  btn.onclick = () => {
    document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    for (const pane of ['code', 'trace', 'report']) {
      $(`out-${pane}`).classList.toggle('hidden', pane !== btn.dataset.tab);
    }
  };
}

// ---------- 样本加载 ----------
const sampleSel = $('sample') as HTMLSelectElement;
sampleSel.onchange = async () => {
  if (!sampleSel.value) return;
  input.value = await (await fetch(`./samples/${sampleSel.value}`)).text();
  status.textContent = `已加载 ${sampleSel.value}（${input.value.length} B）`;
};
input.addEventListener('input', () => {
  $('st-in').textContent = String(input.value.length);
});

function busy(on: boolean, label = ''): void {
  btnRun.disabled = on;
  btnProbe.disabled = on;
  status.textContent = on ? `${label}…（wasm 求值中）` : label;
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

// ---------- 反混淆 ----------
btnRun.onclick = async () => {
  const code = input.value.trim();
  if (!code) return;
  busy(true, '反混淆');
  const t0 = performance.now();
  try {
    const report = await deobfuscate({
      code,
      backend: 'quickjs',
      samples: Number(($('samples') as HTMLInputElement).value) || 2,
      maxRounds: Number(($('rounds') as HTMLInputElement).value) || 4,
    });
    const ms = Math.round(performance.now() - t0);
    const out = report.finalCode ?? '';
    outCode.textContent = out || '（无输出）';
    $('st-in').textContent = String(code.length);
    $('st-out').textContent = String(out.length);
    $('st-applied').textContent = String(report.applied.length);
    $('st-rolled').textContent = String(report.rolledBack.length);
    const pass = report.finalValidation?.pass === true;
    $('st-pass').innerHTML = pass ? '<span class="pass">✓ 行为恒等 PASS</span>' : '<span class="fail">✗ 终验失败</span>';
    $('st-time').textContent = `${ms} ms · ${(report.backend as string) ?? ''}`;

    // 变换轨迹
    const appliedHtml = report.applied
      .map((a) => `<div class="applied-item"><span class="n">${esc(a.name)}</span>@r${a.round} <span class="note">${esc((a.notes ?? []).join(' · '))}</span></div>`)
      .join('');
    const rolledHtml = report.rolledBack
      .map(
        (a) =>
          `<div class="applied-item"><span class="rb">${esc(a.name)}</span>@r${a.round} <span class="note">回滚：${esc((a.reason ?? '').slice(0, 120))}</span></div>`,
      )
      .join('');
    outTrace.innerHTML =
      (appliedHtml || '<div class="note">无已提交变换</div>') +
      (rolledHtml ? `<div style="margin-top:10px" class="note">— 以下提案被锚库拦截（宪法正常工作）—</div>${rolledHtml}` : '');

    // 报告
    const det = report.detection as { family?: string; confidence?: number } | undefined;
    outReport.innerHTML =
      `<span class="kv">家族 <b>${esc(det?.family ?? '?')}</b>（置信 ${(det?.confidence ?? 0).toFixed(2)}）</span>\n` +
      `锚点 ${report.corpus?.samples ?? 0} · 轮数 ${report.rounds ?? 0}\n\n` +
      esc(JSON.stringify({ applied: report.applied, rolledBack: report.rolledBack, finalValidation: report.finalValidation, missingEnv: report.missingEnv, envMisses: report.envMisses }, null, 2));

    busy(false, `完成 ${ms}ms`);
  } catch (e) {
    busy(false, `错误：${(e as Error).message}`);
    outCode.textContent = `错误：${(e as Error).stack ?? (e as Error).message}`;
  }
};

// ---------- 侦察 ----------
btnProbe.onclick = async () => {
  const code = input.value.trim();
  if (!code) return;
  busy(true, '侦察');
  const t0 = performance.now();
  try {
    const r = await probe({ code, backend: 'quickjs' });
    const lines: string[] = [];
    lines.push(`家族:        ${r.family}（置信 ${r.confidence.toFixed(2)}）`);
    lines.push(`特征:       ${(r.features ?? []).join(', ') || '（无）'}`);
    const run = r.run as { ok?: boolean; consumed?: Record<string, number>; gasUsed?: number; console?: Array<{ level: string; text: string }>; envMisses?: Record<string, number>; netMisses?: string[]; evalLog?: string[]; netLog?: Array<{ method?: string; url?: string }> };
    lines.push(`封闭运行:    ok=${run.ok}  seeds=${JSON.stringify(run.consumed ?? {})} gas=${run.gasUsed ?? 0}`);
    lines.push(`console(${run.console?.length ?? 0}):`);
    for (const c of (run.console ?? []).slice(0, 30)) lines.push(`  [${c.level}] ${typeof c.text === 'string' ? c.text : JSON.stringify(c.text)}`);
    if (run.evalLog?.length) lines.push(`eval/Function 生成码 (${run.evalLog.length}):\n` + run.evalLog.slice(0, 10).map((x) => `  ${x.slice(0, 120)}`).join('\n'));
    if (run.netLog?.length) lines.push(`网络请求 (${run.netLog.length}):\n` + run.netLog.map((n) => `  ${n.method ?? 'GET'} ${n.url}`).join('\n'));
    if (run.netMisses?.length) lines.push(`缺流量 fixture: ${run.netMisses.join(', ')}`);
    if (run.envMisses && Object.keys(run.envMisses).length) lines.push(`缺环境 API: ${JSON.stringify(run.envMisses)}`);
    if (r.pool) {
      lines.push(`字符串池 (${r.pool.items.length}${r.pool.decoded ? '，解码明文' : '，编码态'}):`);
      for (const it of r.pool.items.slice(0, 25)) lines.push(`  ${JSON.stringify(it)}`);
    }
    if (r.warnings?.length) lines.push(`警告:\n` + r.warnings.map((w) => `  ! ${w}`).join('\n'));
    outCode.textContent = lines.join('\n');
    (document.querySelector('.tabs button[data-tab="code"]') as HTMLButtonElement).click();
    busy(false, `侦察完成 ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    busy(false, `错误：${(e as Error).message}`);
    outCode.textContent = `错误：${(e as Error).stack ?? (e as Error).message}`;
  }
};

// 默认塞一个 JSFuck 样本引导
(async () => {
  try {
    input.value = await (await fetch('./samples/jsfuck.js')).text();
    $('st-in').textContent = String(input.value.length);
    status.textContent = '已加载演示样本：JSFuck 全编码，点击「反混淆」';
  } catch {
    /* 无样本也允许手贴 */
  }
})();
