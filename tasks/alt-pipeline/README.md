# 山寨币分析流程 · 脚本化改造

> 改造日期：2026-05-21 ~ 2026-05-22
> 状态：✅ 全部完成

---

## 目录结构

```
tasks/alt-pipeline/                    ← 本目录
├── README.md                          ← 本文件
├── alt-intel-stage1-v2.md             ← 阶段一（sentiment 收集）
├── alt-intel-sentiment.md             ← 媒体+链上数据收集指引
└── alt-intel-stage2.md                ← 阶段二（分析 + trade-decision + alert-candidates + 阶段交接）
```

> ⚠️ 阶段三：全脚本化 → `scripts/stage3-executor.js`
> ⚠️ 阶段四：LLM 在阶段二一次性完成筛选决策，`stage4-executor.js` 纯脚本执行。

---

## 完整流程

### 入口一：定时扫描（每小时整点）

```
Linux cron (0 * * * *)
  │
  └── scanner-runner.sh（纯脚本）
       ├── scanner-full.py     → 扫描：ticker→排序→筛A/B/C→OI，命中 COIN
       ├── stage1-prep.js      → 预处理：上线检查→周期创建→持仓同步→合约数据→历史报告
       │     失败 → 退出
       │     成功 → openclaw cron add (1min)
       │
       └── agentTurn（LLM）
            ├── 读 alt-intel-stage1-v2.md    → 收集媒体 + 链上数据
            ├── gen-stage1-manifest.js        → 生成数据清单
            ├── 读 alt-intel-stage2.md        → 交叉验证 → alt-report-*.md
            │                                    → trade-decision-*.json
            │                                    → alert-candidates-*.json
            ├── stage3-executor.js             → 仓位执行（纯脚本）
            │     ├── 持仓=0 → 归档 + 复盘cron → 结束
            │     └── 持仓>0 → 继续
            └── stage4-executor.js             → 归档旧规则 + 生成新规则（纯脚本）
```

### 入口二：警报触发（引擎检测到条件）

```
规则 check() 返回 true
  │
  └── trigger(data):
       execSync stage1-instant.js '<collect() JSON>'
         │
         ├── 解析警报 → 定位活跃周期 → 同步持仓
         ├── 获取即时合约数据 → 复用已有 media/onchain
         └── openclaw cron add (1min)
               │
               └── agentTurn（LLM）
                    ├── 读 alt-intel-stage2.md  → 交叉验证 + JSONs
                    ├── stage3-executor.js       → 仓位执行
                    └── stage4-executor.js       → 警报规则更新
```

---

## LLM 参与点

整个流程中，LLM 只做两次推理：

| 环节 | 内容 | 说明 |
|------|------|------|
| **阶段一 sentiment** | 媒体搜索 + 链上数据收集 | 非结构化数据，无法脚本化 |
| **阶段二** | 交叉验证分析 + 报告 + trade-decision + alert-candidates | 核心推理：三维数据交叉验证 + 开仓策略 + 警报候选筛选 |

其余步骤——扫描、预处理、数据清单、仓位执行、规则归档/创建、周期归档、复盘 cron——全部脚本化，零 LLM 参与。

---

## 脚本索引

| 脚本 | 用途 |
|------|------|
| `scanner-full.py` | 🆕 扫描引擎：ticker→排序→筛A/B/C→OI筛选 |
| `scanner-runner.sh` | 🆕 Bash wrapper：扫描→prep→cron add |
| `stage1-prep.js` | 🆕 阶段一预处理（上线→周期→持仓→合约→历史报告） |
| `stage1-instant.js` | 🆕 即时分析数据采集 + 自动派发阶段二 |
| `gen-stage1-manifest.js` | 🆕 数据清单 JSON 生成 |
| `stage3-executor.js` | 🆕 仓位执行：开仓/加仓/减仓/平仓/调整 + 归档 + 复盘cron |
| `stage4-executor.js` | 🆕 警报规则执行：读取 candidates → 归档 + 按模板生成规则文件 |
| `sync-alt-positions.js` | 🆕 山寨币持仓同步（OKX→positions.json） |
| `alt-scanner-screening.py` | 已有 筛A（黑名单）+ 筛B（活跃周期） |
| `alt-scanner-oi-filter.py` | 已有 OI 变化获取与排序 |
| `calc-position.js` | 已有 止损位 + 仓位计算 |
| `calc-alt-hedge-y.js` | 已有 BTC 趋势对冲系数 |
| `archive-cycle.js` | 已有 周期统一归档（盈亏同步→规则清零→目录移动） |
| `archive-rules.js` | 已有 警报规则归档 |

---

## 数据文件

| 文件 | 用途 |
|------|------|
| `data/non-alt-list.json` | 🆕 非山寨币排除名单（94 个） |
| `data/altcoin-blacklist.json` | 已有，扫描阶段 + 阶段二强庄检测维护 |

---

## 阶段产出物

```
active/alt-{COIN}-YYYYMMDD-HHMM/
├── positions.json                    ← 持仓同步写入
├── data-context/
│   ├── sentiment-media.md            ← 阶段一产出
│   ├── sentiment-onchain.md          ← 阶段一产出
│   ├── data-manifest-*.json          ← gen-stage1-manifest.js 产出
│   └── data-manifest-instant-*.json  ← stage1-instant.js 产出
└── reports/
    ├── alt-report-*.md               ← 阶段二产出（给人读）
    ├── trade-decision-*.json         ← 阶段二产出 → 阶段三输入
    └── alert-candidates-*.json       ← 阶段二产出 → 阶段四输入
```

---

## 改造进度

| 模块 | 状态 | 原来 | 现在 |
|------|:--:|------|------|
| 扫描 | ✅ | LLM 执行 | `scanner-full.py` 纯脚本 |
| 阶段一 prep | ✅ | LLM 执行 | `stage1-prep.js` 纯脚本 |
| 阶段一 sentiment | ✅ | LLM 执行 | LLM（保留） |
| 阶段一 manifest | ✅ | LLM 执行 | `gen-stage1-manifest.js` 纯脚本 |
| 阶段一即时 | ✅ | LLM 读 md 文件 | `stage1-instant.js` 纯脚本 + 自动派发阶段二 |
| 阶段二 | ✅ | 纯 LLM | LLM 分析 + 输出结构化 JSON（trade-decision + alert-candidates） |
| 阶段三 | ✅ | LLM 读 md 文件 | `stage3-executor.js` 零 LLM |
| 阶段四 | ✅ | LLM 读 md 文件 | LLM 在阶段二一次性筛选 + `stage4-executor.js` 纯脚本执行 |
| 警报触发闭环 | ✅ | spawn LLM 读 4 个 md | trigger() → `stage1-instant.js` → 自动派发阶段二 |

---

*详见 changelog/2026-05-21-山寨币流程LLM减负.md*
