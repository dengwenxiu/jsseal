# jsseal 架构文档

> 本文描述 v0.1（M0+M1）的实现架构。总体方法论（环境封闭 → 采样造锚 → 性质分析 →
> 渐进变换）见 workspace《方案设计.md》§9。

## 0. 数据流总览

```
输入 code
  │
  ├─▶ detector.detect(code) ──▶ Detection { family, obfuscatorIO?: { decoderNames,
  │                                              stringArrayNames, prologueSource } }
  │
  ├─▶ anchors.buildCorpus(code, samples=N)
  │      └─ 每样本：record 预跑（录种子磁带）→ 自检重放（必须逐位复现）
  │         → 锚点 (tapes, expectedOutput)
  │
  ├─▶ core.buildPins(code) ──▶ FunctionPin[]（函数名→原始文本切片）
  │
  └─▶ governor 循环（round 1..maxRounds）：
         for transform in defaultPipeline:
           ast = parse(current)
           res = transform.run(ast, ctx)          # 提案（可能含封闭运行时求值）
           candidate = print(ast)
           v = anchors.validateCorpus(corpus, candidate, { pins })
           v.pass ? 提交（current=candidate，同步 pins）: 回滚（连续失败 2 次禁用）
         直到一轮无任何变更
       终验 → 输出 + 报告（applied/rolledBack/missingEnv/sealOverview）
```

## 1. @jsseal/runtime — 封闭执行内核

### 1.1 Sealing Prelude（guest 内注入，`prelude.ts`）

| 职责 | 实现 |
|---|---|
| 种子拦截 | `Math.random / Date(new Date/now) / performance.now / crypto.getRandomValues/randomUUID` —— record 模式录制原始值入磁带；replay 按调用序取值，耗尽即置 `flags.tapeExhausted` 并抛哨兵错误 |
| console 劫持 | 全部方法记录 `{level, text}`，text 为 `__canon` 规范化串（key 排序 / NaN / -0 / Error 专序 / 环引用标记） |
| storage | localStorage/sessionStorage 捕获写入学入输出向量 |
| toString 钉死 | ① pins 命中（函数名）→ 原始文本；② 未命中 → **去换行文本**（免疫 ReDoS/换行型格式检测：beautify 只加空白不改 token 序列；token 真变了则锚库拦截） |
| 定时器 | 确定性 no-op（`flags.timers` 标注降级），回调不执行 |
| 环境 stub | window/self/global 别名、navigator/screen/location/history/document 最小模板、atob/btoa |
| 结果通道 | `__jsseal_ret_raw`（原始 JSON，不经 __canon 二次编码）——解码批量求值用 |

### 1.2 后端

- **quickjs**（默认）：quickjs-emscripten（wasm，零 native 依赖，线性内存硬隔离）。
  `setMemoryLimit + setInterruptHandler`（超时）；句柄必须显式 dispose（evalCode/setProp
  所有权语义），否则 runtime dispose 断言失败
- **nodevm**（开发调试）：node:vm 同一 prelude；锚库比较必须固定在同一后端内

### 1.3 已踩坑记录

- `setMaxStackSize` 不能设置（wasm 构建栈上限远小于 native，设置即 eval 失败）
- 模板字符串内的 `\n`/`\s` 正则转义必须双写（`\\n`），否则 prelude 语法错误
- evalCode 错误句柄 → `setProp` 挂全局 → CAPTURE_TAIL 捕获（含 Error 专序化）

## 2. @jsseal/anchors — 锚库

- **compareOutputs**：ok / ret / thrown / console / storage / consumed（四类种子计数）
  逐字段；flags 为诊断信息不参与相等
- **验证的双向哨兵**：多消费种子 → 磁带越界（tapeExhausted）；少消费/乱序 →
  consumed 计数不一致。两者都是屏障破坏，一票否决
- **自检**：建库时每样本用原代码重放一次，不能复现的样本丢弃（防宿主非确定性）

## 3. @jsseal/detector（定向类）

字符串特征（packer/jsfuck/jjencode/aaencode/sojson/jsjiami/awsc/webpack）+
AST 特征（obfuscator.io：字符串数组函数/轮转 IIFE/解码函数/hex 名）。

**三件套提取**：按源码切片（stringArray fn + rotate IIFE + decoder），切片在封闭
运行时独立执行即得可用解码器（函数声明提升保证 IIFE 可先行调用 decoder）。

**解码函数判定**：引用字符串数组名即候选（encoding:'none' 时解码器只是索引+偏移，
无 fromCharCode 等原语——初版要求原语导致漏检，已放宽）。

## 4. @jsseal/transforms — 恒等变换集

管线顺序（每步经 governor 锚库验证）：

```
strip-antitamper → fold-constants → member-normalize → inline-decoder
→ inline-object-mapping → dead-code → split-sequences
→ inline-proxy-functions → unflatten-cff → demangle-names
```

- **strip-antitamper 最先**：selfDefending 的匿名检测函数无法被 AST 级 pins 覆盖，
  beautify 触发惩罚分支会污染后续所有验证（实测教训）
- **inline-decoder**：别名链（`var a=b`）+ 包装层（`w(a,b){return dec(a+off,b)}`，
  静态小求值器代入置换/偏移）解析调用点 → 封闭运行时批量求值（**种子零消费
  校验=纯度前提**）→ 字面量回填 → 不动点清理死别名/死包装 → 三件套移除
  （判定：prologue 外引用为 0。**存活包装/别名对 decoder 的引用必须计数**——
  它们有非字面量调用点，依赖链尚存，删了就是 ReferenceError，实测教训）
- **inline-object-mapping**：const 对象字面量（函数属性=单 return 且仅用形参）的
  调用点代入；实参需字面量/标识符，或形参在体内恰好用一次（避免重复求值）
- **unflatten-cff**：`while(!![]){switch(seq[i++]){...}break}` 标准形；seq 声明
  支持 `'a|b|c'.split('|')` 与常量成员（对象映射 `m.xJszW.split('|')`，经
  path.evaluate 解析顺序串）；case 体内含裸跳转则放弃（保守）
- **fold-constants**：批量收集顶层可折叠节点（父子不重叠）+ 分批替换——
  单次 traverse 内 6k+ 次 replaceWith 会 requeue 撑爆调用栈（实测教训）
- **demangle**：`_0x[hex]{3,}` → `v_N`（全局唯一），返回 renamePairs 供 pins 同步

## 5. @jsseal/core — governor

- 变换连续失败 2 次 → 本文件禁用（防反复回滚空转）
- **corpus 不可用（无法封闭）→ 拒绝一切变换**，原样返回（宪法：没有锚点就没有变换）
- **buildPins**：函数声明 / var 赋值 / 对象属性与原型方法赋值（selfDefending 的
  检测函数挂在 prototype 上——初版只收 var/function 导致漏 pin，实测教训）
- 报告：applied / rolledBack（含失败原因）/ missingEnv（自由变量分析=缺环境清单）/
  sealOverview（种子消费概览）/ finalValidation

## 6. 测试体系

- 单测：runtime 9（录制/重放一致性、磁带越界、toString 钉死、入口钉参、超时、双后端）
  / anchors 7（采样、篡改拦截、恒等通过、双向屏障破坏）/ transforms 7（各变换单元）
- **e2e**：javascript-obfuscator 4.2.2 五种配置的真实产物（base64/rc4/full/cff/deadcode）
  → 断言：识别正确、行为恒等（finalValidation.pass）、明文回归、体积/混淆名显著下降
- fixtures 生成脚本 `tools/gen-fixtures.mjs`，产物入库（hermetic）
- 负例测试：在已还原代码上偷改常量 → 同一锚库必须拦截

## 7. 已知问题与设计债

1. **单路径覆盖**：悬空引用逃逸一例（round2 变换 + 未执行路径）——forced execution
   是正解（roadmap G）
2. **对象映射/解码内联的清理均为"尽力而为"**：残留包装依赖链是保守正确行为
   （ob-full 样本字符串未全量内联的原因）
3. 匿名函数 toString 免疫是启发式（去换行），引擎级 FunctionRegistry（M2 fork
   quickjs-ng）才是根治
4. 事件循环确定性（虚拟时钟）、网络 VCR：G 阶段
5. LLM 结构化微变换接口已预留（Transform 接口 + governor 验证框架天然兼容），未接入

## 8. M2 引擎决策（2026-10-31 确认）

**native C 为主力，wasm 仅作 MVP 验证**（v0.1 的 quickjs-emscripten 后端定位降级为
零安装兜底 + 双后端差异测试，不承载深度插桩特性）。

| 项 | 决策 |
|---|---|
| 引擎底座 | fork quickjs-ng（纯 C，C11），补丁只挂稳定挂点：解释器 dispatch 表 / interrupt handler / 字符串构造函数 |
| 开发环境 | native 上开发：lldb/gdb + ASAN/UBSAN/valgrind；wasm 同步 CI 构建作差异测试（同一磁带双后端重放必须一致） |
| 插桩能力（native 独占） | opcode 级 trace（C 侧 ring buffer + 批量导出，禁止每事件一次跨边界调用）、gas 计量、原生污点传播、guest 不可觉察的种子拦截 |
| 分发 | esbuild 式矩阵：macos-arm64/x64、linux-x64/arm64、windows-x64，N-API（node_api.h 纯 C，跨 Node 版本稳定 ABI）+ prebuildify + optionalDependencies |
| 安全 | native 引擎跑不可信代码必须进程隔离（worker_thread / child process）；CI 开 ASAN/UBSAN + 沿用 quickjs-ng fuzzing 基建 |
| 备选集成形态 | 独立引擎进程 + stdout JSONL trace 流（零 ABI、宿主语言无关、天然崩溃隔离）——"底层工具"定位的完全体，与 NAPI 可共存 |
| 分层拦截 | prelude（JS 层，两后端通用，第一层兜底）+ 引擎层原生钩子（根治层）。JS 层补丁可被 `delete Math.random` 绕过、被 toString 觉察；引擎层在 guest 看来不存在 |
| rebase 责任 | 补丁集由项目维护（用户只消费二进制产物），最小化补丁 + 稳定挂点控制每次同步成本（v8-taint 停在 r10182 的教训） |

## 9. M2 落地记录（2026-10-31，native 引擎首批能力）

**fork 策略更新（用户决策）**：不维护与上游的最小 diff，自由大改；仅记录基线
（`engine/quickjs/BASE_COMMIT.txt` = 7b5f588e）供未来 AI 对 diff 重放。理由：上游微小
变更对本项目不重要，架构演化方向优先；若上游架构大变，未来用新版 quickjs 重改造。

### 已落地

| 能力 | 实现 |
|---|---|
| native 引擎 | `engine/quickjs`（quickjs-ng fork）+ `engine/addon/jsseal_engine.c`（N-API，`engine/build.sh` 编译）→ `@jsseal/engine-native` |
| 引擎级种子拦截 | `JSContext.jsseal_seeds`：mode + 四类磁带（random/date/time/crypto）。拦截点：`js_math_random`（xorshift64star）、`date_now(ctx)`（含 `new Date()` 无参构造与 `Date.now()`）、`js_perf_now`、原生 crypto（`JS_AddSealCrypto`：C 实现 getRandomValues/randomUUID，独立 crypto 磁带） |
| C API | `JS_SetSealSeedMode / JS_SetSealSeedTape / JS_GetSealSeedTape / JS_GetSealSeedConsumed / JS_GetSealSeedExhausted / JS_AddSealCrypto` |
| **guest 不可觉察** | 引擎级拦截不触碰 JS 层属性——`Math.random.toString()` 返回 `function random() {[native code]}`、`delete Math.random` 无法恢复真实随机（实测验证）。prelude 的 JS 覆盖在 native 后端自动让位（`engineSeeds` 开关） |
| 默认后端切换 | CLI/core 默认 native（`isEngineAvailable()` 探测，失败自动降级 quickjs-wasm） |

### 双层拦截职责（native 后端）

```
引擎级（根治层，不可觉察）：random / date / time / crypto 四类磁带
prelude（第一层，兼容层）：console / storage / toString pins / 定时器 stub / 环境模板 / __canon
```

### 新踩坑记录

- `JS_SetPropertyStr` **consume** 属性值引用——Set 后再 FreeValue 即双重释放
  （gc_decref_child 断言崩溃，worker 进程连带挂掉——native 崩溃风险的第一次现实提醒）
- quickjs.h 里 `#define JSSEAL_SEED_*` 宏与 quickjs.c 的同名 enum 冲突（宏替换标识符）
- prelude 的 crypto 熵源曾引用引擎 Math.random → 双层交叉污染计数——已由引擎级
  crypto（独立磁带）根治
- crypto 计数语义差异：native 按字节记槽（8 字节=8），prelude 按 u32（=2）——各自自洽

### 回归基线

46/46（runtime 双后端 23 + transforms 7 + anchors 7 + e2e 9，其中 native e2e 含
与 quickjs 后端产物**逐字节一致**的跨后端确定性验证）。

## 10. M2.3 落地记录（2026-10-31，trace 基建 + gas）

### 引擎能力

| 能力 | 实现 |
|---|---|
| **gas 计量** | 挂 `__js_poll_interrupts`（每 10000 ops 一单位），限额在 prelude 之后生效（prelude 开销不计入 guest）。超限抛 `jsseal_gas_exhausted` → `flags.gasExhausted`。**确定性资源上限**——壁钟超时作为副线保留（gas 是主限制的确定语义版本） |
| **call 事件** | `has_call_argc:`（OP_call0-3/OP_call/OP_tail_call）与 OP_call_method 两个挂点，记录 {fn, argc} |
| **sret 事件** | 调用返回处（非异常路径）ret_val 为字符串时记录 {fn, v}（截断 512）——**解码器输出捕获的引擎级版本** |
| trace 缓冲 | DynBuf 直接序列化 JSON 流，200k 事件上限 + truncated 标志 |
| C API | `JS_SetGasLimit / JS_GetGasUsed / JS_SetTraceEnabled / JS_GetTraceJSON` |

### 验证

- 51/51 全绿（新增 trace 测试 5 项：sret 捕获/重放 trace 一致/gas 确定性/gas 限额哨兵/prelude 不计入）
- **ob-full 演示**：trace 捕获 288 次解码调用、60 个去重明文（含 SECRET_KEY_123 与方法名池）——
  覆盖静态 inline-decoder 处理不了的**非字面量参数调用点**（M2.4 trace 驱动变换的数据基础）
- gas 确定性实测：同代码两次消耗逐位一致（210000 == 210000）

### 新踩坑

- NAPI：对 undefined 值取子属性 = JS 语义的 `undefined.x` → pending exception 泄漏到
  调用方（"Cannot convert undefined or null to object"）——所有 napi_get_named_property
  前必须 typeof 检查
- gas 若从 ctx 创建即生效，prelude 自身（~12KB 初始化）就会耗尽小额限额——限额语义
  必须是"prelude 后生效"

### 下一步（M2.4 方向）

trace 驱动变换：sret 事件按 fn 聚合 → 解码器动态输出表 → 非字面量调用点的保守内联
（需配合调用点参数 trace）；opcode 级 trace（CFF 执行序还原）挂 dispatch 循环。

## 11. M2.4 落地记录（2026-10-31，trace 驱动变换）

### 新引擎能力

| 能力 | 实现 |
|---|---|
| **cret 事件** | 调用返回处记录 `{fn, args[], v}`（实参+返回值均限原始类型，argc≤8，任一非原始则跳过）；`JSSEAL_TRACE_CALL_ARGS`(bit2) |
| **cret 函数名白名单** | `JS_SetTraceCretFnFilter`（≤8 个名字）——过滤 rotate 洗牌循环等初始化噪声（实测：无过滤时洗牌循环数万次迭代×十余调用直接灌爆 20 万事件上限，解码事实全被截断） |
| **trace 窗口** | 仅覆盖用户代码执行（prelude/dump 内部调用不计——prelude 的 console 封装与 dump 的逐字符序列化同样会灌爆上限） |

### 新变换（管线顺序）

```
strip-antitamper → fold → member → freeze-string-array → inline-decoder
→ decoder-lookup-table → inline-object-mapping → dead-code → sequences
→ proxy-inline → unflatten-cff → demangle
```

| 变换 | 机制 |
|---|---|
| **freeze-string-array** | 封闭运行时执行三件套 prologue → 读出 rotate 后池终态 → 数组函数替换为"返回终态字面量（缓存引用形状）" + 删除 rotate IIFE。**消除 decoder 的洗牌期时变性**——rotate 的唯一可观测效应就是池重排，固化后恒等（锚库验证） |
| **decoder-lookup-table** | 全锚点采样 cret → 聚合 `(fn → argsKey → v)` 表（同 args 不同 v 判非确定放弃）→ decoder 体替换为 `switch(键表达式) { case: return 字面量; default: return 原实现 }`——已观测输入走表、未观测走原实现，对无状态 decoder 恒等 |

### 成果（ob-full 全开样本，此前字符串无法全量回归）

```
freeze-string-array: pool=64/rotate-removed=1
decoder-lookup-table: tables=1/_0xd15c:17
→ SECRET_KEY_123 直接可见 + 全锚点行为恒等 PASS
```

### 本轮踩坑

1. **cret 清理循环越界**：非原始参数 break 后，未初始化槽位是栈上垃圾 → `JS_FreeCString(垃圾指针)` 踩崩栈（lldb 单帧 + 坏地址特征）——清理必须只覆盖 `initialized` 范围
2. **trace 窗口污染**：prelude/dump 阶段的内部调用（__canon 逐字符、JSON.stringify）灌爆事件上限
3. **rotate 噪声**：即使窗口正确，洗牌循环自身的数万次 wrapper→decoder 调用仍灌爆——白名单过滤
4. **decoder 时变性**：同 args 在 rotate 前后返回不同值 → lookup-table 冲突。freeze-string-array 先固化池，时变消失后查表替换安全
5. babel：visitor 内 replaceWith 同名节点会再次命中自身 → `path.skip()`

### 方法学注脚

本轮是"动态产生事实、静态执行改写"的完整闭环第一次跑通：
freeze 的池终态来自运行时（定向假设）→ lookup-table 的 17 个键来自全锚点采样（执行事实）
→ 两者都以恒等变换形式落地（宪法）→ 锚库逐条验证。
conflict 即放弃的保守性（_0xd15c 在 freeze 之前被判 conflicted）正确阻止了错误替换。

## 12. M2.5 落地记录（2026-10-31，执行序探针 → 动态 CFF 还原）

### 新引擎能力

| 能力 | 实现 |
|---|---|
| **br 事件** | `JSSEAL_TRACE_BRANCH`(bit3)。挂点：OP_goto/goto16/goto8/if_true/if_false 五处，`find_line_num`（pc2line）取行号，`{k:'br', fn, l}`。复用函数名白名单（支持 `(anonymous)` 匹配匿名函数） |
| 关键发现 | quickjs 把字符串 switch 编译为**查找表 + goto**（无顺序比较 ladder）——每次分发的 loop-back goto 恰好落在被命中 case 的行区间 → **goto 行序列即 case 命中序**，无需复杂重建 |

### 新变换：unflatten-cff-dynamic

静态 unflatten-cff 要求顺序串可静态求值；顺序串来自函数调用/计算时（自定义混淆器形态）接管：

```
识别"truthy while + switch(seq[i++])"且 seq 静态不可解
→ 全锚点 br 采样（fn 白名单过滤）
→ goto 行 → case 行区间映射 → 命中序
→ 保守条件：无相邻重复（疑似内层循环则弃）、命中数=case 数、跨锚点完全一致
→ 按命中序重排 case 块（锚库逐条验证）
```

fixture `cff-dynamic.js`（getOrder() 返回顺序串）：命中序 `2>0>1>3` → 块按真实执行序排列、分发器消灭、行为恒等。

### 本轮踩坑

- for→while 改写时迭代语句丢失 → Node 侧无限循环挂起（vitest 整场卡死无输出）
  ——排查路径：逐包 vitest → node 直跑 → 定位到 enclosingFnName
- br helper 需 ensure_start/json_str 前向声明（trace 实现区定义顺序）

### 53/53 全绿（runtime 29 / anchors 7 / transforms 7 / e2e 10）

## 13. M2.6 落地记录（2026-10-31，环境探针 + CI）

### 环境探针（自动报缺闭环）

- prelude：`envProbe` 开启时以 Proxy 包装 navigator/document/screen/location/history 五个 stub 对象，
  `get` 未命中即记入 `__jsseal.envMisses`（属性路径 → 次数），随 dump 输出
- core：封板阶段一次 record 运行收集 `envMisses`，与静态自由变量分析（missingEnv）
  互补进报告——静态答"代码引用了哪些未定义全局"，动态答"运行时实际摸了哪些缺失 API"
- CLI：`env misses:` 行输出 Top8
- 调研结论印证：这是中文逆向圈"缺啥补啥"手工循环的开源空白，现在有了数据源

### 测试守卫与 CI

- 全部 native 专属用例改为引擎可用性守卫（`isEngineAvailable() ? it : it.skip`）——
  无 native 二进制的环境（Windows CI）自动降级 wasm 后端跑全量
- `.github/workflows/ci.yml`：macos-14(arm64)/macos-13(x64)/ubuntu-24.04(x64)/
  ubuntu-24.04-arm/windows-2025 矩阵；Windows 暂只跑 wasm（build.sh 为 cc/clang 系，
  MSVC 适配列入待办）
- 55/55 全绿

## 14. M2.7 落地记录（2026-10-31，引擎级污点传播）

### 设计：函数子树粒度（epoch 纪元法）

全值级污点（每个 JSValue 带影子标记、200+ opcode 传播）工程量巨大；本项目采用
**子树粒度**——语义恰好对应纯函数理论的判定需求：

```
JSSealSeedState.epoch：四个种子拦截点（random/date/time/crypto）每次消费递增
调用点：e0 = epoch（进入快照）
返回点：epoch != e0 ⇔ 该调用子树消费过种子 → cret 事件附加 "t":1
```

- **replay 模式同样递增**——感染的是计算形态，与磁带模式无关（实测 record/replay
  污点序列逐位一致）
- 消费者：decoder-lookup-table 跳过感染条目（`tainted-skipped` 计入 notes）——
  "感染即不可常量化"从启发式变成引擎事实；未来 execute-and-inline / T0/T1 纯度
  分级直接消费此标志
- 已知限制：cret 仅覆盖 argc∈[1,8] 且参数全原始类型的调用（argc=0 的函数无 cret，
  污点不可见——后续可加无参 cret 变体）

### 58/58 全绿（runtime 34 / anchors 7 / transforms 7 / e2e 10）

## 15. G.1 落地记录（2026-10-31，虚拟时钟——异步封闭解锁）

### 设计

```
时间读数（Date/performance）→ 磁带（原有，已确定）
定时器 → 虚拟调度：{id, at, seq, fn, interval}，按 (at, seq) 排序
宿主事件循环（主代码后）：循环 { 微任务清空 → runNextTimer() } 直到队列空
  - 微任务优先（引擎 pending jobs，spec 顺序）
  - 同虚拟时刻按注册序（seq）
  - rAF = 16ms 虚拟帧；setImmediate/idle = 0ms
  - 回调异常不终止循环（浏览器语义），记入 console（level=timerError）
  - 100k 步数上限哨兵：永不停止的 interval → flags.timerDropped
```

原生与 wasm 双后端各自实现驱动循环（native 在 C，quickjs-emscripten 在 TS）。

### 语义升级

此前 `flags.timers` 意味"回调丢弃、语义降级"；现在 **async/await、Promise、setTimeout
链全部在封闭模型内确定性执行**——含异步调度的加密样本（此前直接判"不可封闭"）现在
可采样、可锚定、可验证。这是"环境封闭"边界的一次实质扩张。

### 踩坑

- interval 回调内 `clearInterval` 后重注册复活——清除标记（`__clearedTimers`）在
  重注册前检查（回调执行期间条目已出队，队列删除不可达）
- 步数上限标志的边界：`step == MAX-1 且 more 为 true` 时循环自然耗尽退出，
  break 分支的置位逻辑不可达——改为循环外统一判定

### 62/62 全绿

## 16. G.2 落地记录（2026-10-31，网络 VCR）

### 设计（与种子录制同哲学的第三类"环境钉死"）

```
确定性罐头：响应 = 纯函数(method, url, body)（散列文本）→ record/replay 自动同构，无需磁带
fixture 覆盖：netFixtures {url 精确/前缀 → {status, body}}（真机抓包数据注入）
netLog：样本发出的全部请求 {method, url, body} —— 可观测行为，纳入锚库比较
netMisses：配置了 fixture 但未命中的 url —— 缺流量报缺（与 envMisses 同构的闭环）
fetch：Promise + setTimeout(0) → 虚拟事件循环；XHR：最小实现 + onreadystatechange 异步投递
```

CLI：`--net-fixture url=body` 或 `url=status::body`（可多次）。

### 语义

网络从此进入封闭模型：含 XHR/fetch 的风控样本可采样、可锚定、可恒等验证——
**变换改变了请求（URL/body）会被锚库当场拦截**（netLog 参与 compareOutputs）。
逆向价值：`report.netLog` 直接回答"这个样本对外发了什么"。

### 65/65 全绿（含：罐头确定性/fixture 命中/netMisses/锚库拦截 URL 变化）

## 17. G.3 落地记录（2026-10-31，forced execution——多路径覆盖）

### 引擎能力

- `JS_SetForceBranch(ctx, k)`：翻转**第 k 个执行**的条件分支（if_true/if_false 的 4 字节
  与 8 字节变体共四个挂点）；`forceApplied` 回读是否触发
- 锚定**执行序号**而非源码行号（行号在 beautify/重排下漂移——第一版实测教训）
- 注意：quickjs 有 if_true8/if_false8 短跳转变体——只挂 4 字节版时小跳转全部漏掉
  （br trace 一度零事件的根因）

### 锚点模型与验证语义

- `AnchorSample.forceIndex`：强制锚点 = (磁带, 强制序号) → 期望输出
- **验证降格为"路径健康哨兵"**：合法变换（死代码消除/重排）会缩短分支序列使序号前移，
  完整输出比对必然误报 → 只比 ok 状态（"原本正常的强制路径 → 变换后抛错" = 路径破坏）
- **默认关闭**（`forcedBranches ?? 0`）：重度结构变换（删 rotate 等）下序号漂移仍可能
  使健康哨兵误报——适合轻量变换场景/终检，按需 `--forced-branches N` 开启

### 实测验证（kill-heavy 测试）

删除"采样输入下从不执行"的函数定义：普通锚点全部通过（单路径盲区实锤），
强制锚点（4 个）下该函数被强制执行 → ReferenceError → 变换被回滚 ✓

### 结构锚定（后续方向）

彻底解法是 AST 节点路径映射（原分支 ↔ 变换后分支的身份对应），governor 需维护
变换的节点映射表——列入 roadmap。

### 本轮过程教训（工具链）

- addon 源文件曾在某轮 patch 中损坏（不可见坏字节）导致后续所有字符串匹配静默失败、
  功能悄然回退——发现路径：grep 功能关键字为零 → 重写完整文件修复
- python patch 的 replace 全部不报错——**重要 patch 必须 assert 或事后 grep 验证**

### 66/66 全绿

## 18. M3.1 落地记录（2026-10-31，eval/Function 拦截与展开）

### 机制（一个入口吃掉 eval 系家族）

```
prelude 拦截（pass-through + 记录）：
  eval(str) → evalLog.push(str) → 原生执行（行为不变）
  Function(..., body) → evalLog.push('[Function] ' + body) → 原生构造
  toString 原生外观（defineProperty name + nativeLook 表）——guest 不可觉察

unfold-eval 变换：
  全锚点采样 evalLog（一致性校验；强制锚点跳过）
  → eval 调用点（整语句、单参）按序对应前 N 条（嵌套 eval 多出的条目属内层，下一轮处理）
  → 替换为生成代码的解析语句（内联处 var 提升与 direct eval 语义一致）
  → 锚库逐条验证
```

覆盖：packer（实测：识别→展开→PACKER_SECRET_42 可见→恒等 PASS）、嵌套 eval 链
（逐轮展开）、jjencode/aaencode（同机制，eval 收口）。JSFuck（Function 构造器路线）
v1 仅记录报告，构造器链的静态回填列入后续。

### 踩坑

- `globalThis.eval = function(){}` 成员赋值**不产生推断名**（name=''）→ nativeLook
  不命中；strict 模式下命名函数表达式又不能与外层重名 → `Object.defineProperty(name)` 方案
- 嵌套 eval 的 evalLog 条目数 > 调用点数——对应关系是"前 N 条"而非"数量相等"

### 69/69 全绿

## 19. M3.2 落地记录（2026-10-31，ctor 链回填 + 发布准备）

### unfold-ctor-chain（JSFuck 核心形态）

- **形态 A（静态）**：`X["constructor"]("payload")()` → payload 内联——字符串字面量
  直接回填，无需探针
- **形态 B（JSFuck 全编码）**：AST 判定"子树内无任何 Identifier/StringLiteral/
  NumericLiteral"（方法名全部动态构造的结构特征）→ evalLog 的 `[Function] body`
  事实按序对应回填（多锚点一致性校验）
- 仅处理"立即调用"形态；赋值/传参形态跳过
- 实测：`[]["filter"]["constructor"]("console.log('CTOR_CHAIN_OK')")()` → 明文回归 + 恒等

### 发布准备

- LICENSE（MIT）、根 package.json 元数据（0.2.0 / keywords / engines）
- CI 五矩阵、README、docs 齐备；git 未提交（待用户指令）

### 70/70 全绿

## 20. M3.3 落地记录（2026-10-31，侦察模式 probe）

### core.probe + `jsseal probe` 子命令

一次封闭运行（record + 环境探针）输出全维度分析报告：

```
family/features | run ok/thrown | 种子消耗 + gas + flags
console 流 | eval/Function 生成码 | 网络请求(netLog) | 缺流量(netMisses)
缺环境 API(envMisses×次数) | storage 写入 | 字符串池解码明文
```

**池明文预览**：对 decoder 参数区间（0..4096）扫描求值，保序去重——直接给出全部
解码字符串（实测 base64 样本：SECRET_KEY_123 / fromCharCode / token: 全部可见），
无需先跑完整反混淆管线。这是分析员工作流的第一入口：先侦察、再定变换策略。

### 72/72 全绿

## 21. 实战闭环（2026-10-31，真实样本 + AI 子任务验收）

### 真实样本（echo094/decode-js 采集 + synchrony 官方测试样本）

| 样本 | 结果 | 产出修复 |
|---|---|---|
| obfuscator-io.js（synchrony 官方，20K） | ✅ 20K→8.4K，行为恒等 | 验证了野外兼容性 |
| sojsonv7.js（101K） | 🔶 池 5501 条固化可见；明文还原度低（有 WARNING 如实告知） | 4 项：混合元素数组/标记不短路/prologue 自包含/逐键时间性冲突 |
| jsconfuser.js（10K） | 🔶 家族已识别；状态机 CFF 未实现（膨胀 32% 有 WARNING） | jsconfuser 签名识别 |

### AI 子任务验收（外部 Agent 视角，两轮）

- 初测 **6.5/10** → 8 条文档问题（PASS 语义陷阱/字段名失配/help 缺项/验收流程缺失等）+ 6 条工具问题（pool 静默缺失/还原度无告警/help 不同步等）
- 修复后复测 **8/10**，剩余 4 条（help 残缺/参照快照不存在/字段小误/措辞）本轮全部修复并提交
- **最有价值的洞察**："验证正确 ≠ 还原成功"——sojsonv7 PASS 但还原度 0.3%，子任务差点"带着虚假成就感交付"。已固化为 CLI WARNING 启发式 + AGENTS.md 顶部警示

### 方法论验证

锚库拦截在实战中的价值：sojsonv7 的 inline-decoder 因轮转时序依赖被正确回滚（坏产物被拒），
lookup-table 的同参不同值被逐键识别为时间性冲突——宪法机制对未知样本的防错能力得到确认。

## 22. jsconfuser 状态机 CFF 分析（已知局限，2026-10-31）

### 样本结构（与 obfuscator.io 的本质差异）

```
obfuscator.io:  while(!![]){ switch(seq[i++]) { case '0': ...; continue; } break; }
               分发值 = 字符串数组元素（简单索引）
               顺序串 = 'a|b|c'.split('|')（可静态/动态提取）

jsconfuser:     while(sum(states) !== 终值) { switch(sum(states)) { case N: ... } }
               分发值 = sum(数值数组)（每次 case 执行后 8 路加法扰动改变 sum）
               case 标签可为动态表达式（case states[3] - -162）
               顺序由初始 states + 扰动系数唯一确定（可模拟但不可静态提取字符串序）
```

### 还原策略分析

1. **扰动过滤**（可行）：`states[N] += <expr>` 形态的语句是纯状态扰动（噪音），
   可从 case 体中过滤——留下的即业务语句
2. **执行序模拟**（可行但工程量大）：初始 states 来自 sequence 切片 + 魔数
   （`[...slice(0,12), 989, ...slice(13,22), 755, ...]`），全部为字面量 →
   可静态模拟 while 循环逐步计算 sum → 按序收集真实 case 体
3. **动态 case 标签**（可行）：`case states[3] - -162` 在模拟中求值即知目标 case
4. **opaque predicate 混合**（难点）：case 内的 if/else 两分支可能都是纯扰动
   （如 `if(scope.var > 10){扰动A} else {扰动B}`），需区分"含真实逻辑的条件"与
   "纯状态转移选择"

### 实施估算

核心难点在 4（区分 opaque predicate），需要"过滤后 case 体为空"的判定规则 +
跨锚点一致性校验。预估 1-2 天专职开发。当前以 xor 字符串解密（已交付）+
膨胀 WARNING 如实告知为过渡方案。

### xor 解密已交付

`jsconfuserUnfold` 变换：封闭运行时执行完整业务代码，劫持 `cff_xor` 捕获
(key,start,length)→v 调用对，按序静态回填（实测 4/4）。作用域伪装属性名
（'xuswZB'/'VLT7SR'/'Jn1uMOC'）明文回归。



## 23. jsconfuser 状态机 CFF 攻坚成功（2026-10-31，v0.4.0）

### 实现路径

```
1. findStateMachine：AST 检测 while(cff_sum(states)!==N){switch(cff_sum(states))}
2. instrumentAst：AST 级注入（Program 开头声明 orderVar + 每 case unshift push 调用）
   ——替代 Regex 字符串注入（Babel 重打印后 while( → while ( 格式不确定，Regex 失效）
3. 封闭运行时执行 instrumented 代码 → case 命中序（如 [3,4,7,1]）
4. fall-through 收集：从入口 case 到 break/return 间的所有语句
5. isPerturbation 过滤：
   - states[N] ±= ... → 扰动（删）
   - break / _return / _result 声明 → 扰动（删）
   - 双侧纯扰动 if/else → 整体过滤
   - ReturnStatement → 永远保留（业务返回值）
   - scope.xxx = ... → 不是扰动（即使 RHS 引用 states）
```

### 踩坑

1. **字符串 Regex 注入在 Babel 重打印后失效**（while( → while (）——AST 级注入根治
2. **fall-through 漏收**：case 4 命中后穿透 5（真实逻辑）→ 6 → 7 → 8(break)；
   只收集入口 case 会漏掉全部业务语句
3. **ReturnStatement 误判为扰动**：return 携带业务返回值，永远不是扰动

### 实测

jsconfuser/control-flow-flattening.js：10342 → 3170 字节（-69%），
while/switch 完全消除，target 函数体业务语句（scope 赋值 + a+b 计算）可见，
console.log(target(3,4)) 明文回归，行为恒等 PASS。

### 三个真实野外样本全部 ✅

| 样本 | 大小 | 家族 |
|---|---|---|
| synchrony 官方 obfuscator-io.js | 20K→8.4K (-59%) | obfuscator.io |
| sojsonv7/sample_189.js | 101K（池5501固化+轮转删+inline） | sojson v7 |
| jsconfuser/control-flow-flattening.js | 10K→3.2K (-69%) | jsconfuser |

## 24. M4 交付（2026-10-31，v0.5.0）：LLM 插件 + 分支指纹 + JSFuck

### LLM 辅助重命名（`llm-rename.ts`）

四后端可插拔：mock（确定性启发式）/ openai / anthropic / ollama。
原则：**LLM only suggests names**——LLM 输出 JSON `[{old, new}]`，Babel `scope.rename`
执行（结构 1:1），锚库验证把关。mock 后端根据使用模式推断
（charCodeAt→charBuf / push→stack / split→parts / JSON→jsonData 等约 30 种模式），
同名自动加序号后缀（charBuf→charBuf2）。

### AST 分支指纹（`branch-fingerprint.ts`）+ 强制锚定集成

指纹 = 分支测试表达式打印文本（去空白）。性质：
- beautify/格式化后**稳定**（恒等变换不改语义内容）
- 死代码消除后存活分支**不变**（序号自动迁移 via `buildMigration`）
- 标识符重命名后**变化**（保守不映射——安全降级）

**集成到 forced execution**：governor 构建强制锚点时记录分支指纹；
验证变换后代码时，用 `buildMigration` 做指纹→新序号映射——
分支被合法消除则跳过该锚点（不再误报），存活则用新序号（不再漂移）。

### JSFuck 核心形态（e2e fixture）

`[]["filter"]["constructor"]("payload")()` → ctor 链展开 → payload 明文回归 ✓

### 80/80 全绿

## 25. JSFuck 全编码折叠（2026-10-31，fold-jsfuck）

### 方法

字符集 `[]()!+/` 的表达式子树在**语法层面**就是纯函数——不可能含标识符/赋值/属性写
（`/` 仅作除法；正则字面量误入候选会被"只回填原始值"过滤，RegExp 是对象）。
封闭求值 → 回填原始字面量，是"环境封闭 → 条件纯函数"方法论最纯的案例：零 prologue、零种子。

### 关键设计

- **极大候选 + 原始偏移切片**：用 node.start/end 从 ctx.code 切文本判 charset（零打印开销）
- **Call/New 根禁止求值**：外层 payload 执行调用留给 unfold-ctor-chain（此处求值 = 执行
  payload，恒等性必被锚库击落）；`[]["fill"]` 求值为函数 → 非原始值跳过，形态识别还要用它
- **memo 按源文本缓存**：确定性保证同一文本必得同一值；已知失败的根下钻收集子候选
  （A+B 整体超深失败时 A 单独可折叠）
- **求值结果走 `__jsseal_ret_raw` 通道**：完成值通道经 `__canon` 二次编码（踩坑：
  `JSON.parse(out.ret)` 得到字符串而非数组，长度不等 → 全部判失败）
- **产物链**：fold-jsfuck 产出字面量 → unfold-ctor-chain 形态 A **静态**内联
  （此前形态 B 依赖 evalLog 跨锚点一致性，静态路径更稳）

### 编码器（scripts/gen-jsfuck.mjs，测试样本生成）

可达字符集：false/true/undefined/NaN/Infinity（1e1000 技巧）+ 原生构造器 toString
（`[]["fill"]`、`("")["constructor"]`→String 等）+ 数字（`+!+[]+[]`）+ 小数点（`1/11`
字符串第 2 位）。**原生格式必须实测**：quickjs-ng 是 `function fill() {[native code]}`
（V8 是 `{ [native code] }`，空格不同 → 字符索引全错）。

实测：2.8K 全编码 `console.log(1337)` → `folded=3 evaluated=5 failed=2` → 49B 形态 A
→ 18B 明文，PASS。支持矩阵 JSFuck 🔶→✅（escape 扩展字符集：引号/反斜杠未覆盖）。

## 26. 混淆器矩阵压力测试（2026-10-31，实战第二波）

用两个官方混淆器按选项组合批量生成样本过全管线（scripts/stress-matrix*.mjs，
已固化为 matrix.obfuscators.test.ts 回归）：

- **javascript-obfuscator 4.2.2：15/15 完全成功**（PASS + SECRET 可见 + 零回滚）
  含 rc4/shuffle/rotate/cff/deadcode/selfDefending/debugProtection/transformObjectKeys/
  splitStrings/stringArrayCallsTransform 及 all-on 组合
- **js-confuser 2.1.3：17/21**，暴露两代机制更替：
  - **stringConcealing 已换代**：不再是 %95 XOR，而是 Base91 变体
    （table.indexOf + `v+=p*91` 位打包 → UTF-8 buffer）。新变换
    `jsconfuser-strings`：AST 骨架检测（`F(s,l){return D(ANY[slice](s,s+l))}`，
    属性计算表达式也要认——preset minify 会把 "slice" 藏进常量表）+
    cret trace 白名单采集 (args→v) + 跨锚点投票一致才回填
  - **xor 按序回填被击落**：2.1.3 的 xor 调用是 scope 计算键，执行序 ≠ AST 遍历
    序 → 错填 → TypeError 被锚库拦截（宪法工作正常的又一例证）。修复：按
    (start,length) 字面量对分组，**组内全一致才回填**，歧义组整组放弃
  - **cff 动态 case 标签**：`case states[72]-92:`——case 值随扰动演化，静态
    假设失效 → jsconfuser-cff 早期熔断（combo 实测曾单样本空转 100s+ → 11s）
  - **preset 的 dispatcher 间接化**（preset-low/medium/high）：STR 调用经中央
    分发器，无字面量调用点可回填——已知边界，列入 roadmap

### 踩坑
- js-confuser 的 `obfuscate()` 返回 `{code}` 对象不是字符串
- cret trace 白名单要用产物里的实际函数名（每次生成随机）
- **矩阵要固化为测试**：脚本跑一次的结论会随随机种子漂移（xor 组唯一性），
  回归测试锚定"必须 PASS"硬约束 + 已知边界白名单豁免软约束


## 27. Web playground（2026-10-31，浏览器内全管线）

`packages/web`：esbuild 单文件 bundle（1.7MB，wasm base64 内嵌）→ 浏览器里跑
完整 deobfuscate/probe（wasm 后端）。实测：JSFuck 2987B→24B PASS 571ms、
obfuscator.io 池样本 PASS 156ms、probe 16ms。

### 浏览器适配踩坑（4 个）
1. `process is not defined`——Babel 33 处 `process.env.BABEL_*` 探测 → banner 注入
   最小 process stub（env 空对象即可，查不到走默认分支）
2. **quickjs-emscripten 默认 @jitl/wasmfile 变体需要独立 .wasm 文件**（bundle 里
   没有）→ 换 `@jitl/quickjs-singlefile-browser-release-sync`（base64 内嵌，
   bundle +0.6MB）
3. `@jsseal/engine-native` 的 .node require → alias 到 `isEngineAvailable=false` stub；
   `node:vm`（nodevm 后端）→ throw stub；`node:crypto`（ast 的 sha256 缓存键）→ FNV shim
4. **shim 手滑**：`{ update, digest }` shorthand 引用方法名当变量名 →
   `update is not defined`（对象方法名不是作用域绑定——esbuild 不做类型检查，
   手写 shim 要自测）

## 28. 局部函数纯化 purify-closures（2026-11-10，POSITIONING §5.1 落地）

闭包捕获使局部函数不纯 → 两条等价策略显式化依赖：
- **提升**：捕获是单赋值（binding.constant）且初始化"位置无关纯"（字面量/
  模块级引用的组合）→ 声明与函数搬移到模块顶层（**通过提升变量作用域消除
  不纯**）。提升有级联效应：兄弟函数提升后，原本捕获它的函数自动 top-pure。
- **参数化**：捕获会被重赋值 → 前导参数，调用点传当前值（闭包按引用在
  调用时刻读值 → 语义一致，`counter=5→传5` 实测逐位一致）。

安全栅栏（任一不满足即跳过）：捕获在 F 内只读；F 名字引用全部是直接调用
（不逃逸）；F 体内禁 `arguments`（前导参数改变 arguments.length）与 `this`
（提升改变归属）；参数化的每个调用点对捕获名解析到**同一绑定**（防调用点
局部 shadow 的错位：闭包看外层、实参传 shadow）。

### 踩坑
- **递归自引用不是捕获**：`rec(i-1)` 使 rec 进入自由变量集合，binding 解析
  到声明处（祖先函数作用域）→ 被分类为"可提升的兄弟函数"→ applyJob 把 F
  自己 remove 后又执行 F 提升 → NodePath double-remove 崩溃。修复：自由变量
  排除自身名字 + applyJob 同路径防御。
- 实战定位：主流家族（obfuscator.io 池本在顶层；sojson 前置变换后已清空）
  轮到 purify 时已无捕获——它的战场是嵌套形态与后续**通用纯调用求值折叠**
  （top-pure 函数 + 全字面量调用点 → 常量化，解码器查表的泛化）。

## 29. 通用纯调用折叠 fold-pure-calls（2026-11-10，purify 的收益兑现）

top-pure 函数（自由变量全部解析到模块级**单赋值**绑定）+ 全字面量调用点 →
返回值是常量 → 封闭求值（当前代码 + 尾部驱动，`__jsseal_ret_raw` 通道）回填。
**家族无关**：purify 提升后的池+解码器在 detection=plain（无任何家族识别）
时直接折出明文——decoder-lookup-table 的泛化。

### 静态门卫（保守）
- 写目标（赋值/自增/delete）根标识符必须 F 内绑定；禁 this/arguments/eval/
  new/with/yield/标签模板
- 调用白名单：纯内建（Math.* 除 random / String.fromCharCode / 字符串数组
  只读方法 / JSON.parse）或候选集内模块函数（**不动点收敛**：decode 调
  bufferToString 则两者同时通过/出局）
- 未绑定全局必须在纯白名单（console/document 拒）；模块绑定必须 constant
- 名字不逃逸 + 同绑定校验；种子有序屏障由白名单天然保证（Math.random 不在）

### 踩坑：折叠方向
inline-decoder 内联后源码里有明文 `encrypt("hello world")`——直接折叠会把它
**求值回密文** `"; />*t($75;"`（行为恒等 ✓ 但还原度负优化，e2e 明文回归断言
击落）。修复：**方向守卫**——字符串字面量入参 + 字符串返回（加密函数典型
形态）不折；索引型 decoder（数字入参）照常。另：walk 必须区分位置——
`String.fromCharCode` 的属性名被当自由标识符会误拒候选。

## 30. 纯化闭环收尾：propagate-constants + prune-dead-decls（2026-11-10）

purify → fold 的配套两环，三变换链 `传播 → 折叠 → 清理` 完整落地：
- **propagate-constants**：单赋值字面量局部变量内联。解锁器——`var c="<密文>";
  decrypt(c)` 经内联变为全字面量调用点，fold 才能继续折出明文。
- **prune-dead-decls**：fold 折完全部调用点后死函数/死池的家族无关清理
  （不动点：删 A 使 B 也不再被引用）。防误删：eval/new Function 出现即弃；
  `globalThis[k]` 类全局对象动态访问即弃（间接引用静态不可见）。
- **fold 方向守卫升级为可读性启发式**：字符串→字符串折叠只放行
  "入参不透明（符号占比≥0.35）且返回值文本化（字母/空格≥0.9 含 3 连字母）"
  的解密方向；加密方向（明文入参）仍拦截。实测 XOR 密文→hello world 正确放行。

### 踩坑（3 个，都很典型）
1. **code↔offsets 不变式**：同轮前置变换（传播）改过 AST 后，node.start
   与重打印文本错位——fold 用 ctx.code.slice(start,end) 切调用点切出残缺
   片段，驱动直接 SyntaxError。修复：generate(call) 现场打印，不依赖偏移。
   （fold-jsfuck/jsconfuser 依赖同一不变式，它们靠"governor 每轮重 parse"
   天然成立；fold-pure-calls 内部两步才暴露。）
2. **声明 id 自引用**：prune 的 used 集合把 `var dead` 的声明 id 也算引用
   （Identifier visitor 不区分声明位置）→ 一个都删不掉。
3. **globalThis[k] 静态不可见**：动态字符串引用无法静态穷举——接收者是
   全局对象的访问出现即整体放弃；真实生效的动态引用另有锚库兜底。

### 战果
cff-dynamic fixture 产物从"顺序正确的语句序列"进一步折叠为**单字面量
`"bacd"`**（拼接链全求值 + 函数全清理）——比原测试断言的还原目标更彻底，
两个 e2e 断言升级以匹配更优产物。

## 31. LLM 驱动改写提案 llm-rewrite（2026-11-10，POSITIONING §4.4 落地）

"LLM 提案，governor 裁决"的完整实现：LLM 直接提案改写后的函数代码
（llm-rename 只建议名字够不着的层次——结构重组/表达式简化/控制流清理），
等价性不靠信任 LLM，靠锚库逐条重放。

- 分块：模块顶层函数逐个送审（prompt 小、失败隔离、回滚粒度细）
- 形态校验：输出必须可解析且为单一 FunctionDeclaration（剥 markdown 围栏）
- provider：mock（确定性 `x = x + 1`→`x += 1` 恒等简化）/openai/anthropic/
  ollama/**custom**（`(code)=>Promise<string>` 任意 LLM 服务注入点）
- e2e 双侧证明：恒等提案被应用（产物含 `+=` 且 PASS）；**恶意提案**
  （custom 注入 `return x + t + 100` 改行为）被锚库回滚、产物不含恶意码、
  终验 PASS——裁决侧的实证

## 32. 环境对齐认知库 env-kit（2026-11-10，方向：补环境）

动机（用户洞察）：**环境即封闭边界本身**——风控 SDK 对环境感知敏感，异常
环境 → 非预期分支 → 锚库采样走偏 → 优化跟着走偏。而"环境正常性不可证明，
只能维护认知"——故架构为认知库而非实现。

- `knowledge.ts`：43 条结构化认知（id/category/severity/desc/expr/capture），
  三类：存在性/跨字段一致性（UA↔platform↔chrome↔plugins 互证——风控强项，
  单字段可伪造矛盾难伪造）/行为级（`[object Navigator]` 内部槽、原型链、
  getter 位置——平面对象 stub 的天敌）
- `audit.ts`：条目编译成 JS 在封闭运行时求值（样本执行后=风控实际看到的
  环境）；`capture.ts`：真机采集脚本从同一认知库派生（单一事实源）
- CLI `env-audit` + probe 集成（envAudit 字段/人类可读摘要）

### prelude 环境层升级（拟真形态）
平面对象 → `Object.create(Ctor.prototype)` + 原型 getter +
`Symbol.toStringTag` 内部槽 + `window.chrome`（Chrome 系 UA）+ 视口/DPR/
Notification/permissions/userAgentData/indexedDB。
自审 30/43 → **42/43**（3 个 high 清零；遗留 Intl 时区=quickjs 引擎边界，诚实留档）。

### 两个意外收获
- **sloppy 赋值静默失败与真浏览器一致**：`navigator.webdriver = true` 在原型
  getter 无 setter 时不生效不抛错——拟真形态的副作用恰好是浏览器真行为，
  篡改须 defineProperty（测试如实改为 defineProperty 形态）
- 审计器天然测出"风控实际看到的环境"——样本改环境的副作用可观测
