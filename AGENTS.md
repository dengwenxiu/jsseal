# AGENTS.md — jsseal 使用指南（面向 AI Agent）

jsseal 是一个**确定性封闭运行时 JS 反混淆器**。核心方法论：**环境封闭 → 采样造锚 → 渐进恒等变换**——每个变换提案都在验证锚库上重放比对，行为恒等才提交，失败自动回滚。因此**放心大胆地用它跑未知样本**：产物要么行为恒等（PASS），要么拒绝输出坏代码（回滚）。

> ⚠️ 最重要的认知：**`final check: PASS` 只保证"行为恒等"，不保证"还原成功"**。一个还原度 0% 的产物同样会 PASS。验收还原度看 §3 的三要素（WARNING 行 / 池明文数量 / hex 名残留），不要只看 PASS 交付。

## 0. AI 时代你为什么应该用 jsseal 而不是直接读混淆代码

作为 AI Agent，正确工作流是**先 jsseal 后分析**，理由：

1. **省上下文**：字符串池/CFF/eval 链/JSFuck 这类机械混淆由确定性变换零 token 清除，你只需分析残余的真正业务逻辑。
2. **产物可信**：你如果自己改写代码，没有任何机制保证没改错（错误可能一直不被发现）；jsseal 的产物有锚库逐位验证的恒等性保证。
3. **用 probe/trace 拿"性质"而不是猜**：`jsseal probe` 给你家族、池明文、网络流、缺环境 API；trace 事实（cret 实参-返回对、污点标记、真实执行序）是可直接引用的代码性质——基于性质推理比盯着混淆文本可靠得多。
4. **如果你要驱动改写**：让 LLM 直接产出"改写后代码"不可取（无等价保证）；正确形态是 LLM 提案、governor 裁决（编程 API 的每个变换都过锚库；LLM 驱动变换 API 在路线图中）。

完整论述见 [docs/POSITIONING.md](docs/POSITIONING.md)。

## 1. 使用（预构建产物可直接跑）

```bash
cd jsseal  # 克隆到哪都行，示例假设仓库根目录名为 jsseal
node packages/cli/dist/index.js --help     # 所有命令与选项
```

若 dist 缺失或引擎需重建（贡献者）：
```bash
npm install && npx tsc -b && bash engine/build.sh && npm test   # 98 测试应全绿
```

- native 引擎不可用时自动降级 wasm 后端（trace/污点/强制分支等高级特性仅 native 有）
- **产物务必用 `-o` 指定输出路径**——默认写到输入同目录（`<input>.deobf.js`），会污染样本目录
- 也可以用浏览器演练场做快速人工验证：`npm run -w @jsseal/web start` → http://127.0.0.1:8642（wasm 后端，与 CLI 同一管线）

## 2. 两个命令

### `probe <样本>` —— 先侦察（分析员工作流第一步）

```bash
node packages/cli/dist/index.js probe 样本.js            # 人类可读
node packages/cli/dist/index.js probe 样本.js --json      # 机器可读（--entry/--args/--net-fixture 同主命令）
```

输出：混淆家族、console 流、**eval/Function 生成的代码**（evalLog）、网络请求（netLog）、缺的环境 API（envMisses）、缺的流量 fixture（netMisses）、storage 写入、种子消耗、**字符串池预览**、以及 `警告:` 行。

**字符串池预览的两种状态**（`--json` 中为 `pool.decoded`）：
- `解码明文`：decoder 可单参求值，全部解码字符串直接可见（无需跑完整管线）
- `编码态（未解码）`：双参 RC4 等无法单参扫描——池内容仍可见但是密文，且会有对应 `警告:` 行提示反混淆管线对该样本的还原能力受限

**侦察结论决定策略**：envMisses 多 → 补环境；netMisses 多 → 准备 `--net-fixture`；pool 已是解码明文 → 直接反混淆；pool 是编码态 + RC4 → 预期管理（见 §4 sojson 行）。

**何时用 `--entry`**：样本是"库形态"（顶层只定义函数、无自执行入口）或加密函数需要钉死参数时。判据：probe 的 console 流为空 + ret 为 undefined → 多半需要 `--entry 函数名 --args '["输入"]'`。

### `<样本>` —— 反混淆

```bash
node packages/cli/dist/index.js 样本.js -o out.js --report report.json
```

常用选项（完整见 `--help`）：`--entry/--args`（入口钉参）、`--samples 3`（锚点数）、`--net-fixture url=body`（可重复；`url=状态码::body`）、`--forced-branches N`（默认 0 关闭）。

> `--forced-branches` 是**验证强化**（强制翻转分支检查未执行路径的破坏），**不是还原度旋钮**；开启约 2 倍耗时，重度结构变换样本可能误报。

## 3. 验收产物（必做）

1. **看 `WARNING:` 行**（CLI 已内置还原度启发式）：
   - `字符串池还原度极低`——inline-decoder 被锚库回滚（多为解码器有轮转时序依赖），产物仍含编码字符串；
   - `产物比输入膨胀 N%`——对未还原样本的格式化变换净收益为负。
2. **比三要素**：输入/输出大小、hex 名残留（`grep -c '_0x'`）、明文可见性。
3. **可复现性自检**：同输入跑两次 `diff` 产物应逐字节一致（工具是确定性的）；sojson/jsconfuser 样本在 echo094/decode-js 仓库有 `.fix.js` 人工校验版可对照。

## 4. 支持矩阵（诚实）

| 家族 | 反混淆 | 说明 |
|---|---|---|
| obfuscator.io 全配置（RC4/包装层/死代码/CFF/selfDefending） | ✅ | **官方混淆器矩阵 15/15**（全选项组合 PASS+明文可见+零回滚） |
| sojson v5–v7 / jsjiami | ✅ | 池 5501 条固化 + 轮转器删除 + inline-decoder 全通过（M3.5 攻坚成功） |
| js-confuser 2.1.3 | ✅ | Base91 stringConcealing + xor 分组回填 + 状态机 CFF；preset 的 dispatcher 间接化为已知边界（保证 PASS，明文部分可见） |
| 动态 CFF（顺序串运行时计算） | ✅ | br trace 执行序还原 |
| packer（Dean Edwards）/ 嵌套 eval 链 / ctor 链 | ✅ | eval 拦截展开 |
| JSFuck 全编码 | ✅ | fold-jsfuck 原子折叠（charset 纯函数求值）→ ctor 形态 A 静态内联；escape 扩展字符集（引号等）未覆盖 |
| JSVMP 虚拟化 | ❌ | 领域公认空白 |

## 5. 报告字段（JSON，camelCase）

`report.json` 关键字段：`detection.family`、`backend`、`corpus.samples/degraded`、`rounds`、`applied[{name,round,notes}]`、`rolledBack[{name,round,reason}]`（**回滚不是错误**，是宪法机制正常工作）、`finalValidation.pass`、`missingEnv`、`envMisses`、`netLog`、`netMisses`、`forcedAnchors`。（还原度 WARNING 只打在 stdout，不在 JSON；`finalCode` 仅编程 API 返回。）

probe 的 JSON：`family`、`warnings[]`、`run.{ok,ret,thrown,console,storage,netLog,netMisses,envMisses,evalLog,consumed,flags,gasUsed}`、`pool.{decoded,items}`、`missingEnv`。

exit codes：`0` 正常；`3` 终验失败（report 仍写出）；`2` 用法错误。

## 6. 编程 API

```js
const { deobfuscate, probe } = require('./packages/core/dist');
const report = await deobfuscate({ code, samples: 3 });  // report.finalCode / finalValidation.pass / warnings 见 CLI 源码同源逻辑
const recon  = await probe({ code });                     // recon.pool.items / recon.warnings / recon.run.netLog
```

## 7. 开发导览（贡献者）

```
engine/quickjs/   引擎 fork（自由大改，基线 BASE_COMMIT.txt；勿与上游对 diff）
engine/addon/     N-API addon（C）——宿主编排全在此（改后必须 bash engine/build.sh）
packages/runtime/ 封闭内核（sealing prelude + 三后端）
packages/anchors/ 锚库（行为恒等比较 + 健康哨兵）
packages/detector/家族识别 + 三件套提取
packages/transforms/ 20 个内置恒等变换（每文件一个，接口见 types.ts；矩阵回归 matrix.obfuscators.test.ts）
packages/core/    governor（验证循环/提交回滚）+ probe
docs/ARCHITECTURE.md 架构与全部踩坑记录（改代码前必读）
samples/          真实样本（sojsonv7 / 野外 obfuscator.io / jsconfuser）
```

**开发纪律**：
1. python/sed patch 必须 assert、事后 grep 验证（本仓库踩过静默失败致功能回退的坑，docs §17）；
2. 引擎 C 改后必须重跑 build.sh（quickjs.o 有时间戳缓存，必要时 touch 源文件）；
3. 变换必须恒等——产物交 governor 验证，不许"顺手优化"；
4. 新能力先写测试（native 用例用 `isEngineAvailable() ? it : it.skip` 守卫）；
5. 提交信息用中文描述动机与教训（供 AI 追踪历史）。
