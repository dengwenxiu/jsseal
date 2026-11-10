# jsseal CLI 完整指南

## 命令概览

```bash
jsseal <input.js> [options]          # 反混淆
jsseal probe <input.js> [options]    # 侦察模式（分析员第一步）
```

## 反混淆命令

```bash
jsseal obfuscated.js -o output.js --report report.json
```

### 选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `-o, --out <file>` | `<input>.deobf.js` | 输出文件（**强烈建议指定**，默认会写到样本同目录） |
| `--entry <name>` | — | 入口函数名（模式②：钉死入口参数） |
| `--args <json>` | `[]` | 入口参数（JSON 数组） |
| `--samples <n>` | `3` | 锚点采样数 |
| `--max-rounds <n>` | `6` | 变换轮数上限 |
| `--backend <kind>` | `native`（可用时） | `native` / `quickjs` / `nodevm` |
| `--timeout <ms>` | `10000` | 单次执行超时 |
| `--net-fixture <u=v>` | — | 网络 fixture（可重复；`u=body` 或 `u=状态码::body`） |
| `--forced-branches <n>` | `0`（关） | 强制分支锚点数（**验证强化，非还原度旋钮**，~2x 耗时） |
| `--report <file>` | — | JSON 报告输出 |
| `--json` | — | 机器可读输出到 stdout |
| `--detect-only` | — | 仅识别 + 封闭诊断 |

### 退出码

| 码 | 含义 |
|---|---|
| `0` | 正常（含 PASS） |
| `2` | 用法错误 |
| `3` | 终验失败（report 仍写出） |

### 何时用 `--entry`

样本是"库形态"（顶层只定义函数、无自执行入口）或加密函数需要钉死参数时。

判据：probe 的 console 流为空 + ret 为 undefined → 大概率需要
```bash
jsseal probe sample.js
# 如果 console 为空：
jsseal sample.js --entry sign --args '["input_data"]'
```

## 侦察模式

```bash
jsseal probe obfuscated.js           # 人类可读
jsseal probe obfuscated.js --json    # 机器可读
```

### 输出解读

```
family:        obfuscator-io (confidence 0.9)     ← 混淆家族
features:      rotate-iife, string-array-fn, ...   ← 命中特征
run:           ok=true                              ← 封闭运行成功
seeds:         {"random":1,...} gas=310000          ← 种子消耗 + gas
console (54):  ...                                  ← 劫持的 console 流
eval/Function 生成码 (3): ...                        ← eval 拦截记录
网络请求 (2):   GET https://... POST https://...     ← netLog
缺流量 fixture: https://...                          ← netMisses
缺环境 API:    navigator.sendBeacon×1               ← envMisses
storage 写入:  {"token":"abc123"}                   ← localStorage
字符串池 (512, 解码明文):                             ← pool 预览
  "SECRET_KEY_123"
  "fromCharCode"
  ...
警告:
  ! 字符串池未解码为明文（双参 RC4...）               ← 还原度预警
```

### 字符串池预览

| 状态 | 含义 | 行动 |
|---|---|---|
| `解码明文` | decoder 可单参求值，全部解码字符串可见 | 直接反混淆 |
| `编码态（未解码）` | 双参 RC4 等无法单参扫描 | 反混淆管线仍可处理（inline-decoder），但 probe 只能显示密文 |

## 报告 JSON 字段

```bash
jsseal sample.js --report r.json
```

```json
{
  "inputHash": "a1b2c3d4",
  "outputHash": "e5f6g7h8",
  "detection": { "family": "obfuscator-io", "confidence": 0.9 },
  "backend": "native",
  "corpus": { "samples": 3, "degraded": false },
  "rounds": 3,
  "applied": [
    { "name": "freeze-string-array", "round": 1, "notes": ["pool=5501"] },
    { "name": "inline-decoder", "round": 1, "notes": ["inlined=10/10"] }
  ],
  "rolledBack": [
    { "name": "some-transform", "round": 1, "reason": "sample#0 diff: ret..." }
  ],
  "finalValidation": { "pass": true, "checked": 3 },
  "missingEnv": { "someGlobal": 2 },
  "envMisses": { "navigator.sendBeacon": 1 },
  "netLog": [{ "method": "GET", "url": "https://...", "body": null }],
  "netMisses": ["https://unmatched.example.com"],
  "forcedAnchors": 4
}
```

### 关键字段

| 字段 | 含义 |
|---|---|
| `finalValidation.pass` | 全部锚点行为恒等 |
| `applied` | 已提交的变换（`@rN` = 第 N 轮） |
| `rolledBack` | 被锚库拦截的提案（**不是错误**——宪法正常工作） |
| `missingEnv` | 代码引用的未定义全局（静态分析） |
| `envMisses` | 运行时摸到的缺失 API（动态探针） |
| `netMisses` | 配置了 fixture 但未命中的 URL |

### 还原度评估

> ⚠️ **`PASS` 只保证行为恒等，不保证还原成功**。

看三要素：
1. **WARNING 行**（CLI 内置启发式）
2. **输入/输出大小比**
3. **hex 名残留**（`grep -c '_0x'`）

## 编程 API

```typescript
import { deobfuscate, probe } from '@jsseal/core';

const report = await deobfuscate({ code, samples: 3 });
// report.finalCode / report.finalValidation.pass / report.applied

const recon = await probe({ code });
// recon.pool.items / recon.run.netLog / recon.warnings
```

## 常见工作流

### 工作流 1：标准反混淆

```bash
jsseal probe sample.js                    # 先侦察
jsseal sample.js -o out.js --report r.json  # 反混淆
```

### 工作流 2：加密函数（需要 --entry）

```bash
jsseal probe sample.js                    # console 为空 → 需要 --entry
jsseal sample.js --entry encrypt --args '["plaintext"]' -o out.js
```

### 工作流 3：网络依赖样本

```bash
jsseal probe sample.js                    # 看 netMisses
jsseal sample.js \
  --net-fixture "https://api.example.com/login=eyJhbGciOi..." \
  --net-fixture "https://api.example.com/user=200::{\"id\":123}" \
  -o out.js
```

### 工作流 4：深度验证

```bash
jsseal sample.js --samples 5 --forced-branches 4 -o out.js
# 更多锚点 + 强制分支探查（耗时 ~2x）
```

## 支持矩阵

| 家族 | 状态 |
|---|---|
| obfuscator.io 全配置 | ✅ |
| sojson v5–v7 / jsjiami | ✅ |
| jsconfuser（含状态机 CFF） | ✅ |
| packer（Dean Edwards） | ✅ |
| 嵌套 eval 链 | ✅ |
| ctor 链（JSFuck 核心） | ✅ |
| 动态 CFF（运行时执行序） | ✅ |
| JSFuck 全编码（基本字符集） | ✅ |
| JSVMP 虚拟化 | ❌ |
