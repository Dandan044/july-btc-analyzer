# 庄币分析流程 · 脚本化改造

> 创建日期：2026-05-25
> 状态：✅ 初版完成
> 基于：`alt-pipeline/` 结构设计，最大化复用

---

## 与普通山寨币管线的差异

| 维度 | 普通山寨币 | 庄币 |
|------|----------|------|
| 扫描逻辑 | 24h 涨跌幅（绝对值） | **4h 涨跌幅（绝对值）** ——两步法 |
| 阶段一 | 媒体+链上数据收集 | 相同（复用 `stage1-prep.js`） |
| 阶段二分析 | 三维叙事 + 趋势跟踪 | **庄家行为阶段识别 + 不逆庄原则** |
| 阶段二盈亏比底线 | ≥ 1.2 | **≥ 1.5** |
| 阶段二 X 值 | 1.5-2.0 | **2.0-2.2** |
| 阶段二 nominal_base | 40u | **30u**（庄币风险更高） |
| 阶段三 | `stage3-executor.js` | `stage3-executor-zhuang.js`（独立副本） |
| 阶段四 | `stage4-executor.js` | **复用** `stage4-executor.js` |
| 周期目录前缀 | `alt-*` | `zhuang-*` |
| 报告命名 | `alt-report-*` | `zhuang-report-*` |
| 日志文件 | `logs/alt-*` | `logs/zhuang-*` |

---

## 目录结构

```
tasks/zhuang-pipeline/                    ← 本目录
├── README.md                             ← 本文件
├── zhuang-intel-stage1-v2.md             ← 阶段一（sentiment 收集 + 庄币视角提示）
└── zhuang-intel-stage2.md                ← 阶段二（庄家行为分析 + trade-decision + alert-candidates + 阶段交接）
```

> ⚠️ 阶段三：全脚本化 → `scripts/stage3-executor-zhuang.js`（复制的独立副本）
> ⚠️ 阶段四：复用 `scripts/stage4-executor.js`

---

## 完整流程

### 入口：定时扫描（每小时）

```
Linux cron (5 * * * *)  ← 建议在 alt-scanner 后 5 分钟错峰
  │
  └── scanner-zhuang-runner.sh（纯脚本）
       ├── scanner-zhuang.py   → 两步法扫描：
       │     ① tickers 粗筛（成交量过滤 → 前 80 个）
       │     ② 逐个取 4H candle → 计算 |涨跌幅| → 排序
       │     ③ 窗口扫描 → 筛A/B/C → OI 筛选 → 命中 COIN
       ├── stage1-prep.js      → 预处理（复用：上线→周期→持仓→合约）
       └── cron add (10s)      → 派发 LLM 会话
             │
             └── LLM 会话:
                  ├── zhuang-intel-stage1-v2.md  → sentiment 收集（庄币视角）
                  ├── gen-stage1-manifest.js      → 数据清单（复用）
                  ├── zhuang-intel-stage2.md      → 庄家行为分析 + 报告
                  │                                  + trade-decision.json（含 zhuang_stage）
                  │                                  + alert-candidates.json
                  ├── stage3-executor-zhuang.js    → 仓位执行（独立副本）
                  └── stage4-executor.js           → 警报规则（复用）
```

---

## 扫描引擎：两步法

庄币扫描与普通山寨的核心差异：

```
普通山寨：tickers(open24h) → 排序 → 筛选
庄币：    tickers(vol24h)  → 成交量粗筛 → 前80个取4H candle → 排序 → 筛选
```

**为什么是两步法：** OKX tickers 端点只提供 `open24h`，没有 `open4h`。两步法先用量筛掉死币（减少 candle 请求数），然后批量获取 4H candle 计算精确涨跌幅。

**性能：** 80 × 200ms = 16 秒（含退避重试，安全上限约 30 秒）。每小时一次，完全在限流容忍范围内。

**退避重试：** 每个 candle 请求失败后自动重试 3 次（指数退避 2s → 4s → 8s）。

---

## LLM 参与点

| 环节 | 内容 | 说明 |
|------|------|------|
| **阶段一 sentiment** | 媒体搜索 + 链上数据收集 | 同普通山寨，增加了庄币视角提示 |
| **阶段二** | 庄家行为分析 + 报告 + trade-decision + alert-candidates | 核心差异：分析框架从「趋势跟踪」变为「庄家行为识别」 |

其余全部脚本化。

---

## 脚本索引

| 脚本 | 用途 | 来源 |
|------|------|------|
| `scanner-zhuang.py` | 🆕 庄币扫描引擎（4h 两步法） | 全新 |
| `scanner-zhuang-runner.sh` | 🆕 Bash wrapper | 全新 |
| `stage1-prep.js` | 阶段一预处理 | **复用**（不改） |
| `stage1-instant.js` | 即时分析数据采集 | **复用**（不改） |
| `gen-stage1-manifest.js` | 数据清单 JSON | **复用**（不改） |
| `stage3-executor-zhuang.js` | 🆕 仓位执行（独立副本） | 复制自 `stage3-executor.js` |
| `stage4-executor.js` | 警报规则执行 | **复用**（不改） |
| `sync-alt-positions.js` | 持仓同步 | **复用**（不改） |
| `alt-scanner-screening.py` | 筛A+B | **复用**（不改） |
| `alt-scanner-oi-filter.py` | OI 筛选 | **复用**（不改） |
| `calc-position.js` | 止损+仓位计算 | **复用**（不改） |
| `calc-alt-hedge-y.js` | BTC 对冲系数 | **复用**（不改） |
| `archive-cycle.js` | 周期归档 | **复用**（不改） |
| `archive-rules.js` | 规则归档 | **复用**（不改） |

---

## 阶段产出物

```
active/zhuang-{COIN}-YYYYMMDD-HHMM/
├── positions.json                    ← 持仓同步写入
├── data-context/
│   ├── sentiment-media.md            ← 阶段一产出（庄币视角）
│   ├── sentiment-onchain.md          ← 阶段一产出（庄币视角）
│   └── data-manifest-*.json          ← gen-stage1-manifest.js 产出
└── reports/
    ├── zhuang-report-*.md            ← 阶段二产出（庄币版）
    ├── trade-decision-*.json         ← 阶段二产出 → 阶段三输入（含 zhuang_stage）
    └── alert-candidates-*.json       ← 阶段二产出 → 阶段四输入
```

---

## Cron 配置建议

在 Linux crontab 中，建议庄币扫描在普通山寨扫描后 5 分钟执行（错峰避免 API 限流叠加）：

```cron
0  * * * * /home/administrator/.openclaw/july-btc-analyzer/scripts/scanner-runner.sh >> /dev/null 2>&1
5  * * * * /home/administrator/.openclaw/july-btc-analyzer/scripts/scanner-zhuang-runner.sh >> /dev/null 2>&1
```

---

## 未来优化方向

- [ ] `stage3-executor-zhuang.js` 中覆写 `NOMINAL_BASE` 为 30（当前靠阶段二 JSON 传参控制）
- [ ] 增加庄币专用的仓位倍率控制（目前与普通山寨共用 `dashboard-settings.json` 的 `positionMultiplier`）
- [ ] 4h 涨跌幅扫描可考虑用 WebSocket 缓存替代 REST 轮询（降低扫描延迟）
- [ ] 庄币黑名单独立维护（庄币黑名单与普通山寨币可能不同）

---

*详见 changelog/2026-05-25-庄币流水线创建.md*
