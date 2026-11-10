# 样本来源说明

本目录存放真实世界混淆样本，用于回归测试与文档演示。均来自公开仓库，
版权归原作者所有，仅用于研究/测试目的。

| 文件 | 家族 | 来源 |
|---|---|---|
| `obfuscator-io.js` | obfuscator.io | [synchrony](https://github.com/relative/synchrony) 官方测试样本 |
| `sojsonv7.js` | sojson v7 (jsjiami) | [echo094/decode-js](https://github.com/echo094/decode-js) `samples/sample_189.js` |
| `jsconfuser.js` | jsconfuser | [echo094/decode-js](https://github.com/echo094/decode-js) `samples/control-flow-flattening.js` |
| `jsfuck.js` | JSFuck 全编码 | 由 `scripts/gen-jsfuck.mjs` 编码器生成（本仓库自制，无第三方版权） |

矩阵压力测试（`packages/core/src/__tests__/matrix.obfuscators.test.ts`）的样本由
[javascript-obfuscator](https://github.com/javascript-obfuscator/javascript-obfuscator) 与
[js-confuser](https://github.com/MichaelXF/js-confuser) 在测试时即时生成，不入库。

若原作者不愿样本被收录，请提 issue，我们会立即移除。
