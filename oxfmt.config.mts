import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

// 非本仓库源码：vendor fork（含上游测试/示例/文档构建脚本）与混淆样本、
// 变换夹具（密文/被混淆的输入数据，不当作可维护源码规范）。
const VENDORED_AND_SAMPLE_FILES = [
  "engine/quickjs/**",
  "samples/**",
  "packages/transforms/fixtures/**",
];

// 工具链本地产物（agent 会话 / 后台任务元数据），不属于源码规范范围。
const LOCAL_TOOL_STATE = [".pi/**", ".serena/**"];

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...ultracite.ignorePatterns,
    ...VENDORED_AND_SAMPLE_FILES,
    ...LOCAL_TOOL_STATE,
  ],
});
