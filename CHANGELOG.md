# Changelog

## Unreleased

- 新变换 `purify-closures`（局部函数纯化，POSITIONING §5.1 落地）：闭包捕获
  显式化——提升（单赋值+位置无关纯初始化 → 声明与函数搬移模块顶层）与
  参数化（重赋值捕获 → 前导参数，调用点传当前值）；安全栅栏：捕获只读/
  名字不逃逸/禁 arguments 与 this/调用点同绑定校验
- 新变换 `fold-pure-calls`（通用纯调用折叠，purify 的收益兑现）：top-pure
  函数（自由变量全为模块级单赋值绑定）在全字面量调用点封闭求值→常量回填，
  **家族无关**（decoder-lookup-table 的泛化）；静态纯门卫（写目标局部性/
  纯内建调用白名单/候选集不动点/种子屏障）+ 方向守卫（字符串入参+字符串
  返回的加密形态不折——实测曾把 inline-decoder 刚内联的明文折回密文）

## 0.5.0 (2026-11-10)

首个公开版本。核心方法论：**环境封闭 → 采样造锚 → 渐进恒等变换**——引擎级
封闭一切非确定性（随机/时间/网络/时钟），把混淆程序变成可重放的确定性纯函数，
每个变换都在锚库上验证行为恒等，失败即回滚。

### 引擎（quickjs-ng fork，自由大改）

- 四类种子磁带（random/date/time/crypto）录制与重放，guest 完全不可觉察
- 虚拟时钟（setTimeout/Promise/rAF 确定性调度）、网络 VCR（罐头响应 + fixture 注入）
- gas 限额（确定性资源上限）、五类 trace 事件（call/sret/cret/br/go）+ 白名单过滤
- 引擎级污点传播（cret 感染标记：输出依赖不稳定变量即不可常量化）
- 分支强制（第 k 个执行的条件分支取反，多路径覆盖验证）

### 反混淆管线（20 个内置变换 + 可选 LLM 重命名）

- **obfuscator.io 全配置**：字符串池冻结/解码内联/查找表/CFF/死代码/代理内联/
  反篡改剥离——官方混淆器 15 选项组合矩阵全 PASS + 明文可见
- **sojson v5–v7 / jsjiami**：池终态固化 + 通用轮转器识别（101K 样本 → 41B）
- **js-confuser 2.1.3**：xor 分组唯一匹配回填、Base91 stringConcealing
  （cret trace 事实 + 跨锚点投票）、状态机 CFF 还原
- **JSFuck 全编码**：charset 子树封闭求值折叠 → ctor 链静态内联（3K → 24B）
- packer / 嵌套 eval 链 / ctor 链 / 动态 CFF（运行时执行序还原）

### 工具链

- CLI：`jsseal <input>` / `jsseal probe`（侦察模式：家族/console/evalLog/
  netLog/envMisses/字符串池预览）+ JSON 报告
- 浏览器演练场（wasm 单文件 bundle，完整管线在浏览器内运行）
- LLM 重命名插件（mock/openai/anthropic/ollama，"LLM only suggests names"）
- 编程 API：`@jsseal/core` 的 `deobfuscate()` / `probe()`

### 测试

98 个测试（单元 + e2e + 双混淆器矩阵回归），CI 五平台矩阵
（mac arm/x64、linux x64/arm64 native；Windows wasm 降级）。
