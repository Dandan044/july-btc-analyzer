# Pipeline — 山寨币/庄币分析流水线

> 统一的阶段任务文件系统。双画像（alt 山寨币 + zhuang 庄币）共享模块化架构。

## 架构

```
pipeline/
├── stage1.md                   ← 阶段一任务书（双画像共享）
├── stage2-alt.md               ← 阶段二组装产物（运行时生成）
├── stage2-zhuang.md            ← 阶段二组装产物（运行时生成）
│
├── manifest-alt.json           ← alt 组装清单：指定用哪些模块、什么顺序
├── manifest-zhuang.json        ← zhuang 组装清单
│
├── modules/                    ← 阶段二模块（按步骤编号）
│   ├── 01-数据准备.md           ✅ 共享
│   ├── 02-止损仓位计算-alt.md   ❌ 画像专属
│   ├── 02-止损仓位计算-zhuang.md
│   ├── 03-保存报告.md           ✅ 共享
│   ├── 04-交易决策JSON.md       ✅ 共享
│   ├── 05-警报决策.md           ✅ 共享
│   ├── 06-收尾日志.md           ✅ 共享
│   ├── 07-阶段交接.md           ✅ 共享
│   └── 08-异常与要求.md         ✅ 共享（核心要求 → {{include}}）
│
└── profiles/                   ← 画像专属内容
    ├── analysis-alt.md          ← 山寨分析框架（双视角+三维叙事+趋势跟踪）
    ├── analysis-zhuang.md       ← 庄币分析框架（四阶段+庄家指纹+不逆庄+闪电战）
    ├── core-requirements-alt.md ← alt 核心要求
    ├── core-requirements-zhuang.md ← zhuang 核心要求
    ├── vars-alt.json            ← alt 变量定义
    └── vars-zhuang.json         ← zhuang 变量定义
```

## 如何工作

### 运行时

```
scanner-runner.sh 命中币种
  → stage1-prep.js（预处理）
  → assemble-stage2.js --profile {alt|zhuang} --write
     读取 manifest-{profile}.json → 按序拼 modules/ + profiles/
     替换 {{var}} + {{include:xxx}} + {{#flag}} 条件块
     → 写入 stage2-{profile}.md（完整文件）
  → dispatch.js 派发 LLM 任务
      → LLM 读 stage1.md（阶段一 sentiment）
      → LLM 读 stage2-{profile}.md（阶段二，已组装好的完整文件）
```

### 修改共享逻辑

编辑 `modules/` 下带 `✅ 共享` 标记的文件 → 两个画像同时生效。

### 修改画像专属逻辑

编辑 `profiles/` 下的文件或 `manifest-*.json` 的组装顺序。

### 修改参数

编辑 `profiles/vars-*.json` → 改步骤号、前缀、X 值范围等。

### 添加新画像

1. 新建 `profiles/analysis-xxx.md`（分析框架）
2. 新建 `profiles/core-requirements-xxx.md`（核心要求）
3. 新建 `profiles/vars-xxx.json`（变量）
4. 新建 `manifest-xxx.json`（组装清单，引用哪些模块）
5. 在 `assemble-stage2.js` 的 profile 校验中加 `xxx`
6. crontab 加一条 scanner-runner.sh --profile xxx

## 占位符语法

| 语法 | 说明 | 示例 |
|------|------|------|
| `{{var}}` | 简单替换，值来自 `vars-{profile}.json` | `{{log_prefix}}` → `alt` |
| `{{#flag}}...{{/flag}}` | 条件块，flag 为 true 时保留 | `{{#zhuang_stage}}...{{/zhuang_stage}}` |
| `{{include:name}}` | 引用 `profiles/name-{profile}.md` | `{{include:core-requirements}}` |

## 关联脚本

| 脚本 | 用途 |
|------|------|
| `scripts/assemble-stage2.js` | 按清单 + 变量组装阶段二完整文件 |
| `scripts/scanner-runner.sh` | 扫描调度，在 dispatch 前调用 assemble |
| `scripts/stage1-instant.js` | 警报触发即时分析，自动检测画像 |
| `scripts/stage3-executor.js` | 仓位执行，`--profile` 路由仓位倍率 |
| `scripts/stage4-executor.js` | 警报规则执行 |

---

*pipeline-v2.0 — 2026-05-30 重构*
