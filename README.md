# jsseal — 确定性封闭运行时 JS 反混淆器

[![ci](https://github.com/dengwenxiu/jsseal/actions/workflows/ci.yml/badge.svg)](https://github.com/dengwenxiu/jsseal/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)](docs/BUILDING.md)

> **核心原理（一句话）**：反混淆的本质是等价改写，而程序等价性不可判定；
> jsseal 在引擎级封闭一切非确定性（随机/时间/网络/时钟），把任意混淆程序
> 连同环境变成**可重放的确定性纯函数**，从而把不可判定的等价性问题变成
> 可机器验证的逐位比对——**每个变换都必须证明自己没有改变任何可观测行为，
> 证明不了就回滚。没有锚点就没有变换。**

```bash
npm install && npx tsc -b && bash engine/build.sh && npm test
node packages/cli/dist/index.js probe samples/obfuscator-io.js
node packages/cli/dist/index.js samples/obfuscator-io.js -o out.js --report r.json
```

**浏览器演练场**（wasm 后端，完整管线在浏览器内运行）：

```bash
npm run -w @jsseal/web start    # 构建 + 本地服务 → http://127.0.0.1:8642
```

![playground](docs/images/playground.png)

```bash
npm install && npx tsc -b && bash engine/build.sh && npm test
node packages/cli/dist/index.js probe samples/obfuscator-io.js
node packages/cli/dist/index.js samples/obfuscator-io.js -o out.js --report r.json
```

**浏览器演练场**（wasm 后端，完整管线在浏览器内运行）：

```bash
npm run -w @jsseal/web start    # 构建 + 本地服务 → http://127.0.0.1:8642
```

## 文档

| 文档 | 内容 |
|---|---|
| [CLI 指南](docs/CLI-GUIDE.md) | 命令/选项/报告字段/常见工作流 |
| [方法论原理](docs/PRINCIPLES.md) | 环境封闭/锚库验证/恒等变换/污点传播 |
| [先进性与定位](docs/POSITIONING.md) | 时代坐标/理论创新/与 AST 工具及 LLM 的对比 |
| [构建指南](docs/BUILDING.md) | 多平台构建/引擎架构/排障 |
| [插件体系](docs/PLUGINS.md) | 变换插件 API/LLM Provider/测试指南 |
| [架构日志](docs/ARCHITECTURE.md) | 28 节实现记录 + 全部踩坑 |
| [AI Agent 指南](AGENTS.md) | 面向 AI 的使用说明 |
| [贡献指南](CONTRIBUTING.md) | 开发纪律/变换开发规则/测试要求 |
| [变更日志](CHANGELOG.md) | 版本历史 |

## 实战成绩（4 个样本全部 ✅，3 个来自真实野外）

| 样本 | 家族 | 大小变化 | 还原效果 |
|---|---|---|---|
| synchrony 官方 obfuscator-io.js | obfuscator.io | 20K→8.4K (-59%) | 字符串池明文+hex 名还原 |
| jsfuck.js（编码器生成全编码） | JSFuck | 3.0K→24B (-99%) | `console.log(1234567890)` 明文 |
| sojsonv7/sample_189.js | sojson v7 (jsjiami) | **101K→41B (-99.96%)** | 完整业务逻辑（2 行） |
| jsconfuser/control-flow-flattening.js | jsconfuser | 10K→3.2K (-69%) | CFF 状态机还原+业务语句可见 |

## 支持矩阵

| 家族 | 状态 |
|---|---|
| obfuscator.io 全配置 | ✅ |
| sojson v5–v7 / jsjiami | ✅ |
| jsconfuser / js-confuser（含状态机 CFF） | ✅（2.1.3 动态 case 🔶） |
| packer / eval 链 / ctor 链 | ✅ |
| 动态 CFF（运行时执行序） | ✅ |
| JSFuck 全编码（[]()!+ 原子折叠） | ✅ |
| JSVMP 虚拟化 | ❌ |

## 先进性：三个时代，一个跃迁

| 时代 | 范式 | 正确性 |
|---|---|---|
| AST 时代（~2018，synchrony/webcrack/REstringer） | 静态规则匹配，语法层、局部 | 无保证——规则错了无声产出错码 |
| 引擎时代（**jsseal**） | 环境封闭成纯函数 → 全局语义优化 | **构造性恒等**：每次变换锚库逐位验证，失败即回滚 |
| AI 时代（CASCADE 等） | LLM 改写/LLM+IR | 依赖 LLM 可靠性，无行为等价证明 |

**AI 时代为什么还需要 jsseal**（详见 [POSITIONING.md](docs/POSITIONING.md)）：

1. **省 token**——常见混淆由确定性变换零成本清除，AI 只分析残余
2. **不犯错的保证先于验证存在**——AI 改错只能事后发现（可能一直发现不了）；jsseal 的等价性由锚库构造性保证
3. **AI 分析基座**——probe/trace 输出代码的*性质*（池明文/调用事实/污点/执行序），比混淆文本多几个维度
4. **（路线图）LLM 驱动变换 API**——LLM 提案，governor 裁决

## 架构

```
engine/quickjs/   引擎 fork（种子磁带/虚拟时钟/gas/trace/污点/分支强制）
packages/
  engine-native/  native 引擎绑定（默认后端）
  runtime/        封闭内核（sealing prelude + 三后端）
  anchors/        锚库（行为恒等 + 健康哨兵 + 分支指纹迁移）
  detector/       家族识别 + 三件套提取
  transforms/     24 个内置恒等变换（+ 可选 LLM 重命名）
  core/           governor（验证循环/提交回滚）+ probe
  cli/            jsseal 命令行
  web/            浏览器演练场（单文件 bundle，wasm 内嵌）
  env-kit/        环境对齐认知库与审计器（环境即封闭边界）
```

## 核心能力

| 能力 | 实现 |
|---|---|
| 种子封闭 | Math.random/Date/performance/crypto → 录制/重放磁带（引擎级，guest 不可觉察） |
| 虚拟时钟 | setTimeout/Promise/rAF 确定性调度（异步样本可封闭） |
| 网络 VCR | 确定性罐头响应 + fixture 注入 + netLog（锚库可观测） |
| gas 限额 | 确定性资源上限（同代码消耗逐位一致） |
| trace | call/sret/cret（实参+污点）/br/go 五类事件 + 白名单 |
| 分支强制 | 第 k 个执行的条件分支取反 + 指纹迁移（多路径覆盖） |
| LLM 重命名 | mock/openai/anthropic/ollama 四后端（"LLM only suggests names"） |
| LLM 改写提案 | llm-rewrite：LLM 直接提案函数改写，governor 锚库裁决（mock/openai/anthropic/ollama/custom） |
| 环境探针 | 缺失 API 自动报告（envMisses/netMisses/missingEnv 三条闭环） |
| 环境认知库 | @jsseal/env-kit：44 条可校验认知（存在性/跨字段一致性/行为级）+ 审计器 + 真机采集（环境即封闭边界，当前对齐 43/44） |

## 已知限制

- **单路径覆盖**：锚库只验证采样输入的执行路径（`--forced-branches` 部分缓解）
- **js-confuser ≥2.1 边界**：cff 动态 case 标签（已熔断保 PASS）、preset 的 dispatcher 间接化
- **JSFuck escape 扩展**：基本字符集（可达字母/数字/括号/`.`）✅；引号、反斜杠等需 escape 技巧的字符未覆盖
- **JSVMP**：尚未支持，但路线已论证——超集指令集 + AI 翻译 + 锚库验证收口，见 [POSITIONING §5.2](docs/POSITIONING.md)
- **Windows native**：暂不支持（自动降级 wasm 后端）

## 安全须知

jsseal 处理的是**不可信代码**。虽然封闭运行时（QuickJS 沙箱 + 种子磁带 + gas 限额 +
网络 VCR）本身就是在隔离环境中执行样本，但仍建议：在容器/虚拟机中运行 CLI；
不要把 `--net-fixture` 里的真实凭据提交进仓库；`report.json` 可能包含样本解出的
明文（密钥、接口地址），公开分享前先脱敏。

## 关于作者

[dengwenxiu](https://github.com/dengwenxiu)，大连理工大学未来技术学院本科生
（jsseal 发布时在读大三）。本项目——从方法论设计（环境封闭/锚库验证/恒等变换）、
quickjs-ng 引擎 fork 的深度改造，到全部变换管线与工具链——为独立完成。
欢迎通过 [issue](https://github.com/dengwenxiu/jsseal/issues) 交流。

## 姊妹项目：jvmp —— 一攻一守，一矛一盾

jsseal 与 [**jvmp**](https://jvmp.cn)（Java 代码虚拟化保护，闭源）出自同一团队，
是同一套代码保护方法论的**一体两面**：

- **jsseal 是矛**（开源）：向社区证明混淆可以被等价地、可验证地消除——
  每一次变换都要过锚库逐位比对，"还原正确"是证明出来的，不是宣称的。
- **[jvmp](https://jvmp.cn) 是盾**（闭源）：把同源的对抗经验用于防护——
  每次构建随机化的种子 ISA、多解释器实例、N 版本语义、语义诱饵，
  让攻击者从一次构建恢复的知识对下一次构建无效；其红队 CI 门禁
  （模拟已知明文映射攻击）同样是"防护有效"的机器证明，而非宣称。

攻击侧的每一条还原路线，反哺防护侧的对抗设计；防护侧的每一代加固，
又是攻击能力的试金石。jsseal 的 JSVMP 反虚拟化路线
（[POSITIONING §5.2](docs/POSITIONING.md)）正出自构建 VMP 的同一批人——
**懂造盾，才更懂破盾**。

> 需要保护 Java / Android 代码？→ **[jvmp.cn](https://jvmp.cn)**
> （Gradle / Maven / Android 插件与云端服务）

## 许可

MIT
