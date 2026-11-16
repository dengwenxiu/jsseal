/**
 * jsseal playground 入口：浏览器内 wasm 后端跑完整管线（反混淆/侦察）。
 * \@jsseal/core 无 Node 依赖，quickjs-emscripten 的 wasm 内嵌在 bundle 里。
 */
import { deobfuscate, probe } from "@jsseal/core";
import type { ProbeReport } from "@jsseal/core";

/** 按选择器取元素：缺失即报错（HTML 与脚本必须同步，缺元素是构建缺陷而非运行态） */
const requireElement = <T extends Element>(
  selector: string,
  kind: new () => T
): T => {
  const el = document.querySelector(selector);

  if (!(el instanceof kind)) {
    throw new TypeError(`playground 缺少元素 ${selector}`);
  }

  return el;
};

const input = requireElement("#input", HTMLTextAreaElement);
const status = requireElement("#status", HTMLElement);
const outCode = requireElement("#out-code", HTMLElement);
const outTrace = requireElement("#out-trace", HTMLElement);
const outReport = requireElement("#out-report", HTMLElement);
const btnRun = requireElement("#run", HTMLButtonElement);
const btnProbe = requireElement("#probe", HTMLButtonElement);
const sampleSel = requireElement("#sample", HTMLSelectElement);
const samplesInput = requireElement("#samples", HTMLInputElement);
const roundsInput = requireElement("#rounds", HTMLInputElement);
const statIn = requireElement("#st-in", HTMLElement);
const statOut = requireElement("#st-out", HTMLElement);
const statApplied = requireElement("#st-applied", HTMLElement);
const statRolled = requireElement("#st-rolled", HTMLElement);
const statPass = requireElement("#st-pass", HTMLElement);
const statTime = requireElement("#st-time", HTMLElement);

const busy = (on: boolean, label = ""): void => {
  btnRun.disabled = on;
  btnProbe.disabled = on;
  status.textContent = on ? `${label}…（wasm 求值中）` : label;
};

const esc = (s: string): string =>
  s.replaceAll(/[&<>]/gu, (c) => {
    if (c === "&") {
      return "&amp;";
    }

    if (c === "<") {
      return "&lt;";
    }

    return "&gt;";
  });

// ---------- 样本加载 ----------
const loadSelectedSample = async (): Promise<void> => {
  if (!sampleSel.value) {
    return;
  }

  const res = await fetch(`./samples/${sampleSel.value}`);

  input.value = await res.text();
  status.textContent = `已加载 ${sampleSel.value}（${input.value.length} B）`;
};

const loadDemoSample = async (): Promise<void> => {
  try {
    const res = await fetch("./samples/jsfuck.js");

    input.value = await res.text();
    statIn.textContent = String(input.value.length);
    status.textContent = "已加载演示样本：JSFuck 全编码，点击「反混淆」";
  } catch {
    /* 无样本也允许手贴 */
  }
};

// ---------- 侦察输出分段 ----------
const consoleSection = (run: ProbeReport["run"]): string[] => {
  const lines = [`console(${run.console.length}):`];

  for (const c of run.console.slice(0, 30)) {
    lines.push(`  [${c.level}] ${c.text}`);
  }

  return lines;
};

const evalLogSection = (run: ProbeReport["run"]): string[] => {
  if (run.evalLog.length === 0) {
    return [];
  }

  const body = run.evalLog
    .slice(0, 10)
    .map((x) => `  ${x.slice(0, 120)}`)
    .join("\n");

  return [`eval/Function 生成码 (${run.evalLog.length}):\n${body}`];
};

const netLogSection = (run: ProbeReport["run"]): string[] => {
  if (run.netLog.length === 0) {
    return [];
  }

  const body = run.netLog
    .map((n) => `  ${n.method ?? "GET"} ${n.url}`)
    .join("\n");

  return [`网络请求 (${run.netLog.length}):\n${body}`];
};

const netMissesSection = (run: ProbeReport["run"]): string[] =>
  run.netMisses.length === 0
    ? []
    : [`缺流量 fixture: ${run.netMisses.join(", ")}`];

const envMissesSection = (run: ProbeReport["run"]): string[] =>
  Object.keys(run.envMisses).length === 0
    ? []
    : [`缺环境 API: ${JSON.stringify(run.envMisses)}`];

const poolSection = (pool: ProbeReport["pool"]): string[] => {
  if (!pool) {
    return [];
  }

  const lines = [
    `字符串池 (${pool.items.length}${pool.decoded ? "，解码明文" : "，编码态"}):`,
  ];

  for (const it of pool.items.slice(0, 25)) {
    lines.push(`  ${JSON.stringify(it)}`);
  }

  return lines;
};

const warningSection = (warnings: string[]): string[] => {
  if (warnings.length === 0) {
    return [];
  }

  const body = warnings.map((w) => `  ! ${w}`).join("\n");

  return [`警告:\n${body}`];
};

const probeLines = (r: ProbeReport): string[] => [
  `家族:        ${r.family}（置信 ${r.confidence.toFixed(2)}）`,
  `特征:       ${r.features.join(", ") || "（无）"}`,
  `封闭运行:    ok=${r.run.ok}  seeds=${JSON.stringify(r.run.consumed)} gas=${r.run.gasUsed ?? 0}`,
  ...consoleSection(r.run),
  ...evalLogSection(r.run),
  ...netLogSection(r.run),
  ...netMissesSection(r.run),
  ...envMissesSection(r.run),
  ...poolSection(r.pool),
  ...warningSection(r.warnings),
];

// ---------- 反混淆 ----------
const runDeobfuscate = async (): Promise<void> => {
  const code = input.value.trim();

  if (!code) {
    return;
  }

  busy(true, "反混淆");
  const t0 = performance.now();

  try {
    const report = await deobfuscate({
      code,
      backend: "quickjs",
      samples: Number(samplesInput.value) || 2,
      maxRounds: Number(roundsInput.value) || 4,
    });

    const ms = Math.round(performance.now() - t0);
    const out = report.finalCode ?? "";

    outCode.textContent = out || "（无输出）";
    statIn.textContent = String(code.length);
    statOut.textContent = String(out.length);
    statApplied.textContent = String(report.applied.length);
    statRolled.textContent = String(report.rolledBack.length);
    const pass = report.finalValidation?.pass === true;

    statPass.innerHTML = pass
      ? '<span class="pass">✓ 行为恒等 PASS</span>'
      : '<span class="fail">✗ 终验失败</span>';
    statTime.textContent = `${ms} ms · ${report.backend ?? ""}`;

    // 变换轨迹
    const appliedHtml = report.applied
      .map(
        (a) =>
          `<div class="applied-item"><span class="n">${esc(a.name)}</span>@r${a.round} <span class="note">${esc((a.notes ?? []).join(" · "))}</span></div>`
      )
      .join("");

    const rolledHtml = report.rolledBack
      .map(
        (a) =>
          `<div class="applied-item"><span class="rb">${esc(a.name)}</span>@r${a.round} <span class="note">回滚：${esc((a.reason ?? "").slice(0, 120))}</span></div>`
      )
      .join("");

    outTrace.innerHTML =
      (appliedHtml || '<div class="note">无已提交变换</div>') +
      (rolledHtml
        ? `<div style="margin-top:10px" class="note">— 以下提案被锚库拦截（宪法正常工作）—</div>${rolledHtml}`
        : "");

    // 报告
    outReport.innerHTML =
      `<span class="kv">家族 <b>${esc(report.detection.family)}</b>（置信 ${report.detection.confidence.toFixed(2)}）</span>\n` +
      `锚点 ${report.corpus.samples} · 轮数 ${report.rounds}\n\n${esc(
        JSON.stringify(
          {
            applied: report.applied,
            rolledBack: report.rolledBack,
            finalValidation: report.finalValidation,
            missingEnv: report.missingEnv,
            envMisses: report.envMisses,
          },
          null,
          2
        )
      )}`;

    busy(false, `完成 ${ms}ms`);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    busy(false, `错误：${err.message}`);
    outCode.textContent = `错误：${err.stack ?? err.message}`;
  }
};

// ---------- 侦察 ----------
const runProbe = async (): Promise<void> => {
  const code = input.value.trim();

  if (!code) {
    return;
  }

  busy(true, "侦察");
  const t0 = performance.now();

  try {
    const r = await probe({ code, backend: "quickjs" });

    outCode.textContent = probeLines(r).join("\n");
    requireElement('.tabs button[data-tab="code"]', HTMLButtonElement).click();
    busy(false, `侦察完成 ${Math.round(performance.now() - t0)}ms`);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));

    busy(false, `错误：${err.message}`);
    outCode.textContent = `错误：${err.stack ?? err.message}`;
  }
};

// ---------- tabs ----------
const tabs = document.querySelectorAll<HTMLButtonElement>(".tabs button");

for (const btn of tabs) {
  btn.addEventListener("click", () => {
    for (const b of tabs) {
      b.classList.toggle("active", b === btn);
    }

    for (const pane of ["code", "trace", "report"]) {
      requireElement(`#out-${pane}`, HTMLElement).classList.toggle(
        "hidden",
        pane !== btn.dataset.tab
      );
    }
  });
}

// ---------- 事件绑定 ----------
sampleSel.addEventListener("change", () => {
  void loadSelectedSample();
});

input.addEventListener("input", () => {
  statIn.textContent = String(input.value.length);
});

btnRun.addEventListener("click", () => {
  void runDeobfuscate();
});

btnProbe.addEventListener("click", () => {
  void runProbe();
});

// 默认塞一个 JSFuck 样本引导
void loadDemoSample();
