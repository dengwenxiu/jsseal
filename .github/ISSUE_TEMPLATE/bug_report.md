---
name: 反混淆失败 / 产物问题
about: 样本反混淆失败、还原度低、或行为改变
labels: bug
body:
  - type: textarea
    id: symptom
    attributes:
      label: 现象
      description: 期望 vs 实际（PASS 但无还原 / 回滚 / 终验失败 / 行为改变 / 崩溃）
    validations:
      required: true
  - type: textarea
    id: sample
    attributes:
      label: 混淆样本
      description: |
        可复现的最小样本，或说明家族（obfuscator.io / sojson / js-confuser / JSFuck / packer …）。
        注意：样本可能包含原文作者的版权与敏感信息（密钥、接口），公开 issue 前自行评估。
    validations:
      required: true
  - type: textarea
    id: probe
    attributes:
      label: probe 输出
      description: '`jsseal probe 样本.js` 的输出（家族识别/池预览/警告行对定位问题最关键）'
  - type: textarea
    id: report
    attributes:
      label: report.json
      description: '`--report r.json` 的产出（applied/rolledBack/finalValidation）；注意可能含解出的明文，酌情脱敏'
  - type: input
    id: version
    attributes:
      label: 版本 / 后端
      description: 版本号 + 后端（native/wasm；`jsseal --help` 或报告的 backend 字段）
  - type: checkboxes
    id: env
    attributes:
      label: 环境
      options:
        - label: 我确认同输入重复运行产物不一致（如果一致，说明是还原度问题而非不确定性 bug）
          required: false
