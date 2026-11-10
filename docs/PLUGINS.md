# jsseal 插件体系

## 恒等变换插件

### Transform 接口

```typescript
// packages/transforms/src/types.ts
interface Transform {
  /** 变换名（报告中显示） */
  name: string;
  /** safe = 纯 AST 变换（无执行求值）；unsafe = 可能改变语义（锚库验证把关） */
  risk: 'safe' | 'unsafe';
  /** 执行变换（可异步——需要封闭运行时求值时） */
  run(ast: t.File, ctx: TransformContext): Promise<TransformResult>;
}

interface TransformContext {
  /** 当前轮的代码文本 */
  code: string;
  /** 家族识别结果 */
  detection: Detection;
  /** 执行后端 */
  backend: 'quickjs' | 'nodevm' | 'native';
  timeoutMs?: number;
  memoryLimitBytes?: number;
  /** 验证锚库（trace 驱动的变换在此采样执行事实） */
  corpus?: Corpus;
}

interface TransformResult {
  changed: boolean;
  notes: string[];               // 报告中显示
  renamePairs?: Array<{ from: string; to: string }>;  // 供 governor 同步 pins
}
```

### 编写示例

```typescript
// packages/transforms/src/my-transform.ts
import * as t from '@babel/types';
import { traverse } from '@jsseal/ast';
import { result, type Transform } from './types';

export const myTransform: Transform = {
  name: 'my-transform',
  risk: 'safe',
  async run(ast, ctx) {
    let count = 0;
    traverse(ast, {
      // Babel visitor
      CallExpression(path) {
        // ... 检测模式并替换
        if (shouldReplace(path)) {
          path.replaceWith(t.stringLiteral('replacement'));
          count++;
        }
      },
    });
    return result(count > 0, [`replaced=${count}`]);
  },
};
```

### 注册到管线

```typescript
// packages/transforms/src/index.ts
import { myTransform } from './my-transform';

export const defaultPipeline: Transform[] = [
  // ... 现有变换
  myTransform,  // 添加到合适位置
];
```

### 管线顺序原则

1. **先便宜后昂贵**：纯 AST 变换（fold/normalize）在前，需执行求值的在后
2. **先解码后结构**：字符串池解码（freeze/inline）在 CFF 还原之前
3. **strip-antitamper 必须最先**：反篡改会污染后续验证
4. **demangle 最后**：改名后其他变换的标识符匹配会失效
5. **llm-rename 可选**：放最末（纯改名，不影响结构）

### 调试技巧

```typescript
// 在变换中打印诊断
return result(changed, [
  `matched=${n}`,
  `skipped=${skipped}`,
  `sample=${JSON.stringify(firstMatch).slice(0, 100)}`,
]);

// 使用封闭运行时求值（需要 ctx.backend === 'native'）
const out = await runSealed({
  code: ctx.code,
  mode: 'replay',
  tapes: ctx.corpus.samples[0].tapes,
  backend: ctx.backend,
  trace: { callArgs: true, cretFns: ['decoderName'] },
});
```

## LLM 辅助插件

### LLM Provider 接口

```typescript
type LLMProvider = 'mock' | 'openai' | 'anthropic' | 'ollama';

interface LLMRenameOptions {
  provider: LLMProvider;
  apiKey?: string;       // openai/anthropic 需要
  model?: string;        // 默认 gpt-4o-mini / claude-sonnet / qwen2.5-coder
  baseUrl?: string;      // ollama 本地服务地址
  maxNames?: number;     // 每轮最多重命名数（默认 50）
  contextLines?: number; // 每个标识符的上下文行数（默认 3）
}
```

### 使用方式

```typescript
import { createLLMRenameTransform } from '@jsseal/transforms';

const llmRename = createLLMRenameTransform({
  provider: 'mock',        // 离线测试用确定性启发式
  // provider: 'openai', apiKey: 'sk-...'  // 真实 LLM
  // provider: 'ollama', baseUrl: 'http://localhost:11434'  // 本地模型
});

const report = await deobfuscate({
  code,
  transforms: [...defaultPipeline, llmRename],  // 附加到管线末尾
});
```

### Mock Provider 启发式

mock 后端根据使用模式推断语义名（约 30 种模式）：

| 使用模式 | 建议名 |
|---|---|
| `.charCodeAt` / `.charAt` | `charBuf` |
| `.push` / `.pop` | `stack` |
| `.split` / `.join` | `parts` |
| `JSON.parse` / `.stringify` | `jsonData` |
| `atob` / `decode` | `decoded` |
| `encode` / `encrypt` | `encoded` |
| `.length` / `.size` | `count` |
| `setTimeout` / `delay` | `delayMs` |
| `catch` / `error` | `err` |
| `for(` / 循环 | `i` |
| 默认（var 赋值） | `value` |
| 默认（函数声明） | `fn` |

同名建议自动加序号后缀：`charBuf` → `charBuf2` → `charBuf3`

### 自定义 LLM Provider

```typescript
async function myProvider(
  names: Array<{ name: string; context: string }>,
): Promise<Array<{ old: string; new: string }>> {
  // 发送到你的 LLM 服务
  const response = await fetch('https://your-llm.example.com/api', {
    method: 'POST',
    body: JSON.stringify({ names }),
  });
  const data = await response.json();
  return data.suggestions;
}

// 注入到 createLLMRenameTransform 内部（需修改源码或 fork）
```

## 测试指南

### 单元测试

```typescript
// packages/transforms/src/__tests__/my-transform.test.ts
import { describe, expect, it } from 'vitest';
import { parseCode, printCode } from '@jsseal/ast';
import { myTransform } from '../my-transform';
import type { TransformContext } from '../types';

describe('my-transform', () => {
  it('基本模式匹配', async () => {
    const code = `var x = pattern("test");`;
    const ctx: TransformContext = {
      code,
      detection: { family: 'plain', confidence: 0.5, features: [] },
      backend: 'quickjs',
    };
    const ast = parseCode(code);
    const r = await myTransform.run(ast, ctx);
    expect(r.changed).toBe(true);
    expect(printCode(ast)).toContain('replacement');
  });
});
```

### E2E 测试

```typescript
// 需要 native 引擎
import { isEngineAvailable } from '@jsseal/engine-native';
const nativeIt = isEngineAvailable() ? it : it.skip;

nativeIt('真实样本还原', async () => {
  const code = load('my-fixture');
  const report = await deobfuscate({ code, samples: 3 });
  expect(report.finalValidation?.pass).toBe(true);
  expect(report.finalCode).toContain('EXPECTED_SECRET');
}, 120_000);
```

### 测试纪律

1. native 专属用例必须用 `isEngineAvailable() ? it : it.skip` 守卫
2. 涉及执行的变换必须验证行为恒等（`validateCorpus`）
3. 每个 fixture 的预期结果写明确（`toContain('SECRET')` 优于 `not.toBeNull()`）
