# jsseal 方法论——环境封闭与锚库验证

> 本文解释 jsseal 的核心原理。如果你只想使用工具，请看 [CLI 指南](CLI-GUIDE.md)；
> 如果你想开发变换插件，请看[插件体系](PLUGINS.md)。

## 1. 核心理念：一句话

> **动态产生事实，静态执行改写。**
> 运行时负责"看清代码在干什么"（字符串真实值、真实执行序、哪些是调度噪声），
> AST 管线负责"把代码改对"（所有结构改写走确定性 Babel 变换）。
> 每一步变换都在验证锚库上重放比对——**行为恒等才提交，失败即回滚**。

这就是"宪法"：**只做确定性恒等变换**。

## 2. 环境封闭（Sealing）

把混淆程序变成**有条件的纯函数**——所有非确定性源被拦截录制：

```
程序 = f(代码, 环境模板, 入口参数, 种子磁带)
```

### 2.1 非确定性源与封闭机制

| 非确定性源 | 封闭机制 | 实现层 |
|---|---|---|
| `Math.random()` | 录制/重放磁带（调用序取值） | 引擎 C 层（不可觉察） |
| `Date.now()` / `new Date()` | 录制/重放磁带 | 引擎 C 层 |
| `performance.now()` | 录制/重放磁带 | 引擎 C 层 |
| `crypto.getRandomValues()` / `randomUUID()` | 录制/重放磁带 | 引擎 C 层（原生注入） |
| `setTimeout` / `setInterval` / `Promise` | 虚拟时钟 + 事件循环驱动 | prelude JS 层 |
| `fetch` / `XMLHttpRequest` | 确定性罐头响应 + netLog | prelude JS 层 |
| 资源消耗 | gas 确定性限额（同代码消耗逐位一致） | 引擎 C 层 |

### 2.2 录制/重放（Record/Replay）

```
Record 模式：
  种子函数（Math.random 等）调用时 → 原始值推入磁带 → 返回原始值
  执行结束后磁带随 dump 导出

Replay 模式：
  种子函数调用时 → 从磁带按序取值 → 返回录制值
  磁带耗尽 → flags.tapeExhausted = true（执行已发散的哨兵）
```

关键性质：**同代码 + 同磁带 = 逐位一致的输出**。这是锚库验证的根基。

### 2.3 有序屏障（Ordered Barrier）

种子调用不可删除、不可重排（比 JS 规范等价更严格的等价定义）。
如果变换删除了一个种子调用（即使结果没人用），重放时磁带取值会错位——
后续所有种子取值都错，锚库立刻拦截。

```js
// ❌ 变换不能做：删除无用的种子调用
var a = Date.now();  // 结果没人用，但调用必须保留
var b = Date.now();  // 依赖第一个调用在磁带中的位置

// ✅ 变换可以做：删除赋值但保留调用
Date.now();
var b = Date.now();
```

### 2.4 Guest 不可觉察（引擎级拦截）

种子拦截在 C 层实现（修改 `js_math_random` / `date_now` / `js_perf_now` 函数本体），
而非 JS 层覆盖属性。效果：

- `Math.random.toString()` → `"function random() { [native code] }"`
- `delete Math.random` → 无法绕过（函数本体被改，属性删除不影响）
- 属性描述符与原生一致

## 3. 锚库验证（Anchor Validation）

### 3.1 采样造锚

```
N 次独立 record 预跑（天然熵扰动）
  → 每次冻结 (种子磁带, 期望输出向量)
  → 锚点 = (磁带, 期望输出)

自检：同磁带重放原代码 → 必须逐位复现（防宿主非确定性）
```

### 3.2 输出向量（可观测行为）

| 字段 | 说明 |
|---|---|
| `ok` | 是否正常完成（无未捕获异常） |
| `ret` | 完成值 / 入口返回值 |
| `thrown` | 未捕获异常 |
| `console` | console 流（劫持捕获） |
| `storage` | localStorage/sessionStorage 写入 |
| `netLog` | 全部网络请求（method, url, body） |
| `consumed` | 四类种子消费计数（有序屏障的硬性比较项） |

**netLog 是可观测行为**：变换改变了请求 URL/body → 锚库立刻拦截。

### 3.3 验证循环（Governor）

```
for each 变换提案（规则/LLM）:
  应用到 AST → 打印候选代码
  → 在全部锚点上重放
  → 全部通过 → 提交（更新当前代码）
  → 任一失败 → 回滚（连续失败 2 次禁用该变换）
```

### 3.4 强制锚点（Forced Execution）

普通锚点只验证采样输入下的执行路径（单路径覆盖局限）。
强制锚点翻转第 k 个执行的条件分支，探查另一条路径：

```
强制锚点 = (磁带, 强制序号, 分支指纹) → 期望输出
```

**分支指纹**（测试表达式文本哈希）解决结构变换后的序号漂移：
- 恒等变换（beautify）后指纹稳定 → 精确映射新序号
- 死代码消除后存活分支指纹不变 → 自动迁移
- 分支被消除 → 跳过该锚点（不再误报）

**验证语义（v2 AST 路径锚定后升级）**：
- **结构锚迁移成功**（形状签名+函数提示+出现次序在变换后代码中唯一定位
  同一分支，并由候选 br trace 重算执行序）→ **全输出比对**——等价于普通
  锚点，强制路径的完整行为受宪法保护
- 迁移失败（分支被合法消除/定位失败）→ 丢弃该锚（不参与本轮验证）
- 无锚锚点（定位失败的历史路径）→ 降格 ok-only 哨兵（v1 行为）

结构锚的形状签名对恒等文本改写稳定（0x10↔16、重命名、格式化——字面量
与标识符占位）；常量折叠等结构性改写会保守失配（丢失锚但绝不误锚）。

## 4. 渐进恒等变换（Identity Transforms）

### 4.1 两类操作原则

| 类别 | 示例 | 约束 |
|---|---|---|
| **定向类**（只读） | 入口发现/家族识别/解码器定位 | 允许启发式与 LLM，错了不污染代码 |
| **改写类**（变更代码） | 一切恒等变换 | 必须确定性 + 锚库逐条验证，无一例外 |

### 4.2 变换管线（默认 20 个内置变换 + 可选 LLM 重命名）

```
strip-antitamper → unfold-eval → unfold-ctor-chain → jsconfuser-unfold
→ fold-constants → member-normalize → freeze-string-array
→ inline-decoder → prune-dead-pool → decoder-lookup-table
→ inline-object-mapping → dead-code → split-sequences
→ inline-proxy-functions → unflatten-cff → unflatten-cff-dynamic
→ jsconfuser-cff → strip-antitamper → demangle-names
→ llm-rename（可选）
```

### 4.3 LLM 的角色

> **LLM only suggests names.** LLM 绝不触碰代码结构。

```
LLM 输入：标识符及其使用上下文
LLM 输出：JSON [{old: "_0xabc", new: "descriptiveName"}]
执行：Babel scope.rename()（结构 1:1）
验证：锚库重放（重命名是恒等变换——通过才提交）
```

## 5. 污点传播（Taint Tracking）

```
种子消费纪元（epoch）：每次 Math.random/Date.now 等调用递增
调用点进入时快照 e0，返回时 epoch ≠ e0 ⇔ 调用子树感染种子
→ cret 事件带 t=1 标志
```

语义："感染了不稳定变量的计算 → 输出是不可常量化的变量"。
消费者（如 decoder-lookup-table）跳过感染条目。

## 6. 侦察模式（Probe）

一次封闭运行，全维度分析报告——分析员工作流的第一入口：

```
jsseal probe 样本.js
  → 家族/特征 | console 流 | eval 生成码 | 网络请求
  → 缺环境 API | 缺流量 fixture | storage 写入
  → 字符串池明文预览（decoder 参数区间扫描）
  → 还原度 WARNING（启发式）
```

## 7. 已知局限（诚实清单）

1. **单路径覆盖**：锚库只验证采样输入的执行路径（强制锚点部分缓解）
2. **匿名函数 toString**：去换行免疫（token 级变化会被锚库拦截）
3. **JSVMP**：尚未支持（devirtualize 路线论证见 [POSITIONING.md §5.2](POSITIONING.md)）
4. **jsconfuser CFF**：✅ 已还原（AST 注入 + fall-through + 扰动过滤）

## 8. 环境对齐与认知库（@jsseal/env-kit）

**环境即封闭边界本身。** 风控对抗 SDK 对环境感知极其敏感——一旦发现异常
（字段缺失/形态不对/跨字段矛盾）就走非预期分支，锚库采样到的就是那条
"错的路"，后续所有优化跟着走偏。因此封闭环境必须尽可能与普通浏览器对齐。

**但"正常性"不可证明，只是认知。** 我们无法穷举风控看什么——只能持续
维护认知库（`packages/env-kit/src/knowledge.ts`）。每条认知必须：

- 可机器校验（`expr` 在封闭运行时内求值，true=对齐）
- 带风控语义（`desc`：为什么看它/它泄漏什么）
- 带泄漏分级（`severity`：修复优先级）

### 三类条目

| 类别 | 检查什么 | 例 |
|---|---|---|
| 存在性/形态 | 单字段类型与典型值域 | `navigator.webdriver === false` |
| 跨字段一致性 | 单字段可伪造，**矛盾难伪造**——风控的强项 | UA 含 Chrome → `window.chrome` 存在；UA 含 Mac → `platform === 'MacIntel'` |
| 行为级 | 内部槽/原型链/getter 位置 | `toString.call(navigator) === '[object Navigator]'`（平面对象 stub 的天敌） |

### 三个工具与两条闭环

```
knowledge（认知库）─→ audit（审计器：封闭运行时内求值，样本执行后=风控实际看到的环境）
       └───────→ capture（真机采集脚本：认知库键派生，控制台粘贴即下载快照）
```

- **认知闭环**：真机快照 → 补认知库 → 审计验证 → 缺口归零
- **开发闭环**：审计暴露缺口 → prelude 补齐（原型+getter+内部槽拟真形态）→ 审计转绿
  （首发实测：30/43 → 42/43，3 个 high 缺口清零；唯一遗留 Intl 时区为引擎边界）

与 envMisses 的分工：envMisses 是"样本摸到了什么缺"（样本驱动、事后）；
envAudit 是"环境本身对不对"（认知驱动、事前/事后皆可）。

### 维护

新认知 = 在 knowledge.ts 加一条（id/desc/severity/expr/capture），测试自动
校验 expr 可解析；`jsseal env-audit <样本>` 随时可审。真机采集脚本由
`buildCaptureScript()` 从同一认知库生成——单一事实源。

### 8.1 插桩旁路与访问图谱

**旁路通道（instrument）**：分析员需要插桩打印时，**不造全局 API**——开源特征
会被风控抓取（遍历 window 成员/固定函数名）。方案是**闭包注入**：宿主把
插桩片段包成 `;(function(dbg){ ... })(隐藏对象.dbg)` 注在 prelude 之后——
`dbg` 只存在于插桩作用域，**零全局足迹**，guest 无法以任何枚举发现。
输出走 `debugLog` 通道，**不进锚库输出向量**（插桩不影响锚点比对）。
插桩片段抛错不炸运行（容错记录进 debugLog）。

**访问图谱（envTrace）**：envProbe 从"只记缺失"扩展为"记录全部属性访问"
（`envAccesses`：key → 次数）——SDK 实际探测面的完整地图，与 envMisses
（摸到缺）、envAudit（环境对不对）构成三层感知。

**内部状态反探测（分级）**：
- ✅ 已做：`__jsseal`/`__jsseal_ret_raw` 非枚举化（keys/for-in/JSON.stringify
  三类穷举向量全隐藏，认知库回归哨兵守卫）
- 🗺 分级路线：随机化内部名（杀 ownNames 直接探测；需动 addon C 契约）→
  闭包化状态对象（宿主持有、guest 全局零痕迹——彻底方案）

### 8.2 浏览器行为模拟的三层判断

JS 可观测的"浏览器行为"只有三类，逐层判断需要性：
1. **API 形态与数值**（布局盒子返回数字、UA/屏幕指纹）——已覆盖（认知库
   守卫 + 真机快照回流）
2. **生命周期事件**（readyState/DOMContentLoaded/load、事件循环次序）——
   虚拟时钟可确定性模拟（roadmap：加载生命周期首片）
3. **渲染/布局/光栅**——**JS 不可见，不需要模拟**（getBoundingClientRect
   之类返回值本身就是数字 stub）。无头模拟 = JS 引擎 + DOM/BOM 结构 +
   事件语义，无渲染管线。判定标尺始终是认知库审计：环境补到审计对齐即止，
   不为看不见的东西付出复杂度
