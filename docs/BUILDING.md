# jsseal 构建指南

## 前置条件

| 依赖 | 版本 | 用途 | 必须 |
|---|---|---|---|
| Node.js | ≥ 18 | TypeScript 编译/运行/测试 | ✅ |
| C 编译器（cc/clang/gcc） | — | 引擎 fork 编译 | 推荐（无则降级 wasm） |
| Python 3 | — | 部分构建脚本 | ✅ |

## 快速构建

```bash
git clone <repo> && cd jsseal
npm install                    # 安装依赖（npm workspaces）
npx tsc -b                     # 编译 TypeScript（8 个包）
bash engine/build.sh           # 编译 native 引擎（quickjs-ng fork + N-API addon）
npm test                       # 运行测试（80 个）
```

## 引擎架构

```
engine/
  quickjs/           quickjs-ng 源码 fork（基线 7b5f588e，自由大改）
    quickjs.c        核心——种子拦截/虚拟事件循环/gas/trace/污点/分支强制
    quickjs.h        公开 C API（JS_SetSealSeedMode 等）
  addon/
    jsseal_engine.c  N-API addon——宿主编排（prelude→代码→事件循环→dump）
  build.sh           构建脚本（macOS/Linux）

产物：
  engine/build/libquickjs.a              静态库
  packages/engine-native/native/jsseal_engine.node  N-API 模块
```

### 引擎修改点（与上游 quickjs-ng 的差异）

| 修改 | 位置 | 目的 |
|---|---|---|
| `JSSealSeedState` | `JSContext` 结构 | 四类种子磁带 + 污点纪元 |
| `js_math_random` 等 | 函数本体拦截 | 录制/重放（不可觉察） |
| `JS_AddSealCrypto` | 新增函数 | 原生 crypto 注入 |
| `JSSealTrace` | `JSContext` 结构 | 五类 trace 事件缓冲 |
| trace 挂点 | `JS_CallInternal` | call/sret/cret/br/go 五类事件 |
| 分支强制 | `OP_if_true/false` ×4 | 第 k 个执行的条件分支取反 |
| gas 计量 | `__js_poll_interrupts` | 确定性资源限额 |
| 虚拟事件循环 | addon C 层 | 微任务⇄定时器交替驱动 |

## 多平台

### macOS（默认支持）

```bash
bash engine/build.sh
# 依赖 Xcode Command Line Tools（cc/clang）
```

### Linux

```bash
bash engine/build.sh
# 依赖 gcc/clang + make
```

### Windows

**Native 引擎暂不支持**（build.sh 为 bash 脚本，需 MSVC 适配）。
**自动降级 wasm 后端**：所有测试中的 native 专属用例自动 skip，
核心反混淆功能（fold/dead-code/demangle 等纯 AST 变换）正常可用。

引擎级特性（trace/污点/分支强制/虚拟时钟宿主驱动）在 wasm 后端不可用。

### CI 矩阵（.github/workflows/ci.yml）

| 平台 | 引擎 | 说明 |
|---|---|---|
| macos-14 (arm64) | native | 全功能 |
| macos-13 (x64) | native | 全功能 |
| ubuntu-24.04 (x64) | native | 全功能 |
| ubuntu-24.04-arm | native | 全功能 |
| windows-2025 | wasm | 降级模式 |

## 排障

### `node_api.h not found`

Node.js 头文件位置因安装方式而异。build.sh 自动探测，如仍失败：

```bash
export NODE_INCLUDE=$(node -e "console.log(process.execPath.replace(/bin\/node$/, 'include/node'))")
```

### `quickjs.o 缓存不更新`

build.sh 按时间戳缓存。强制重编：`touch engine/quickjs/quickjs.c && bash engine/build.sh`

### 引擎崩溃（segfault）

1. 确认 quickjs.o 已重编（时间戳缓存问题）
2. 用 lldb 定位：`lldb -b -o run -o bt -- node your-test.js`
3. ASAN 构建：`mkdir -p engine/build-asan && cd engine && for f in quickjs libregexp libunicode dtoa; do cc -c -O1 -g -fsanitize=address -I quickjs -D_GNU_SOURCE quickjs/$f.c -o build-asan/$f.o; done`
