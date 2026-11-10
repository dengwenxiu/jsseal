#!/usr/bin/env bash
# 编译 jsseal native 引擎（quickjs-ng fork 核心 + N-API addon）
# 产物: packages/engine-native/native/jsseal_engine.node
# 依赖: cc (clang/gcc)、node 头文件（node_api.h）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QJS="$ROOT/engine/quickjs"
BUILD="$ROOT/engine/build"
OUT_DIR="$ROOT/packages/engine-native/native"
OUT="$OUT_DIR/jsseal_engine.node"

# 定位 node 头文件目录（以真实可执行文件为准，处理 symlink/nvm/brew/独立安装）
NODE_BIN="$(node -e 'console.log(process.execPath)')"
NODE_INCLUDE="$(dirname "$(dirname "$NODE_BIN")")/include/node"
if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  # 兜底：常见安装路径
  for cand in "/usr/local/include/node" "/opt/homebrew/include/node" "$HOME/.nvm/versions/node/$(node -v)/include/node"; do
    if [ -f "$cand/node_api.h" ]; then NODE_INCLUDE="$cand"; break; fi
  done
fi
if [ ! -f "$NODE_INCLUDE/node_api.h" ]; then
  echo "ERROR: node_api.h not found (looked at $NODE_INCLUDE)" >&2
  echo "macOS: brew install node 或 npm i -g node-gyp 后用其下载的头" >&2
  exit 1
fi

echo "== node headers: $NODE_INCLUDE"

# 平台/编译器指纹：变化（如 macOS 构建后进 Linux 容器/CI 复用挂载目录）则
# 清空缓存——跨平台复用旧 .o 会静默产出坏 archive（CI 实测：archive has no index）
STAMP="$BUILD/.stamp"
STAMP_VAL="$(uname -s)-$(uname -m)-$(cc --version 2>/dev/null | head -1)"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP" 2>/dev/null)" != "$STAMP_VAL" ]; then
  echo "== 环境变化（平台/编译器不同），清空 build 缓存重编"
  rm -rf "$BUILD"
fi
mkdir -p "$BUILD" "$OUT_DIR"
echo "$STAMP_VAL" > "$STAMP"

# 1) 编译 quickjs 核心（缓存：源码不变则跳过）
# -fPIC 必须加：Linux cc -shared 链接要求全部目标文件为 PIC
# （macOS -bundle 不要求，此前漏加在 mac 上测不出来；CI ubuntu 实测
#   R_AARCH64_ADR_PREL_PG_HI21 ... recompile with -fPIC）
CORE_SRCS=(quickjs.c libregexp.c libunicode.c dtoa.c)
CORE_OBJS=()
for src in "${CORE_SRCS[@]}"; do
  obj="$BUILD/${src%.c}.o"
  if [ ! -f "$obj" ] || [ "$QJS/$src" -nt "$obj" ]; then
    echo "== cc $src"
    cc -c -O2 -fPIC -I"$QJS" -D_GNU_SOURCE "$QJS/$src" -o "$obj"
  fi
  CORE_OBJS+=("$obj")
done
ar rcs "$BUILD/libquickjs.a" "${CORE_OBJS[@]}"

# 2) 编译 addon（quickjs 大改时每次重编）
echo "== cc jsseal_engine.c (addon)"
cc -c -O2 -fPIC -I"$QJS" -I"$NODE_INCLUDE" -D_GNU_SOURCE \
  "$ROOT/engine/addon/jsseal_engine.c" -o "$BUILD/jsseal_engine.o"

# 3) 链接 .node（macOS: -bundle；linux: -shared）
case "$(uname)" in
  Darwin)
    cc -bundle -undefined dynamic_lookup \
      "$BUILD/jsseal_engine.o" "$BUILD/libquickjs.a" \
      -o "$OUT" -lm
    ;;
  Linux)
    cc -shared \
      "$BUILD/jsseal_engine.o" "$BUILD/libquickjs.a" \
      -o "$OUT" -lm -ldl -lpthread
    ;;
  *)
    echo "unsupported platform: $(uname)（Windows 走 CI 矩阵，见 ARCHITECTURE §8）" >&2
    exit 1
    ;;
esac

echo "== OK: $OUT"
