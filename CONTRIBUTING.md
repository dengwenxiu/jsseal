# 贡献指南

感谢关注 jsseal。本项目的方法论决定了贡献有一条**不可妥协的底线**，先讲清楚它，
再说流程。

## 唯一底线：恒等变换

一切改写代码的变换（transform）都必须是**行为恒等**的：

1. 变换本身**不负责验证**——governor（`packages/core`）会把产物放到验证锚库上
   逐条重放比对，行为不一致自动回滚。所以不要在变换里"顺手优化"或"修 bug"，
   那是恒等性被击落的捷径。
2. **没有锚点就没有变换**。如果一个改写无法被锚库验证（例如无法构造确定性
   运行），就不要进入默认管线。
3. 报告里的 `rolledBack` 不是失败，是宪法在工作——提交 PR 时不要为了消掉
   回滚记录而放松验证。

## 开发环境

```bash
git clone https://github.com/dengwenxiu/jsseal.git && cd jsseal
npm install            # npm workspaces，一次装全
npx tsc -b             # 编译 8 个包（project references）
bash engine/build.sh   # 编译 native 引擎（quickjs fork + N-API addon）
npm test               # 98 个测试
```

- 无 C 编译器时跳过 build.sh：自动降级 wasm 后端，纯 AST 变换测试照常跑，
  native 专属用例自动 skip。
- 引擎 C 代码（`engine/quickjs/`、`engine/addon/`）改动后**必须**重跑
  `bash engine/build.sh`（quickjs.o 按时间戳缓存，必要时 `touch` 源文件）。
- 浏览器演练场：`npm run -w @jsseal/web start`。

## 新增一个变换

参考 `docs/PLUGINS.md`（接口与示例）与 `packages/transforms/src/` 下任意现有
变换。要点：

1. 每个变换一个文件，实现 `Transform` 接口（`name` / `risk: 'safe'|'unsafe'` /
   `run(ast, ctx)`）。
2. 需要运行时求值的变换用 `runSealed`（`@jsseal/runtime`），事实提取走
   `__jsseal_ret_raw` 通道或 trace（cret 白名单），不要污染样本输出。
3. 注册进 `packages/transforms/src/index.ts` 的 `defaultPipeline`，位置遵循
   顺序原则：strip-antitamper 最先、解码在结构还原之前、demangle 最后。
4. **测试三件套**：
   - 单元测试（`packages/transforms/src/__tests__/`，fixture 直接写代码字符串）；
   - e2e（`packages/core/src/__tests__/`，断言 `finalValidation.pass` **和**
     明文可见性——只断言 PASS 的测试会放过"验证正确但还原失败"）；
   - native 专属用例必须用 `isEngineAvailable() ? it : it.skip` 守卫。
5. 对抗新混淆家族时，优先用官方混淆器生成矩阵样本并固化为回归测试
   （参考 `matrix.obfuscators.test.ts`）：**PASS 是硬约束，明文还原是软约束**
   （已知边界用白名单豁免，防止把已知边界误报成回归）。

## 已知工程坑（前辈的血泪，改代码前读一遍）

完整清单见 `docs/ARCHITECTURE.md` 各节"踩坑"，高频的几条：

- **python/sed 打补丁必须 assert + 事后 grep 验证**——本仓库踩过坏字节导致
  功能静默回退的坑；
- babel 单次 traverse 大量 `replaceWith` 会栈溢出——先收集再分批替换；
- 脚本化 patch 的字符串比较：JS 引擎间原生函数 `toString()` 格式有差异
  （如 quickjs 与 V8 的空格不同），字符索引类逻辑必须实测；
- quickjs-emscripten 句柄必须显式 dispose；`JS_SetPropertyStr` 会 consume
  值引用（Set 后再 Free = 双重释放）。

## 提交与 PR

- 提交信息用中文，讲清楚**动机与教训**（本仓库历史按"供 AI 追踪"的粒度撰写）。
- PR 前自查：`npx tsc -b` 无错误、`npm test` 全绿、新能力有测试、
  README/AGENTS.md 中受影响的矩阵与计数已同步。
- 新增公开 API / CLI 选项请同步 `docs/CLI-GUIDE.md` 与 `AGENTS.md`（面向 AI
  的文档和面向人的一样重要）。
