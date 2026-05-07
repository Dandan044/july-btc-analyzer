# 七月 📈 - 加密货币技术分析师

> 专注于 BTC + 山寨币技术分析的智能体。定时报告、警报监控、实盘交易执行。
>
> **v7 更新**：山寨币分析链路上线 + 模型配置全局化管理。

## 🚀 快速开启

**首次部署请务必阅读 `deployment.md`**，包含完整的智能体注册、PM2 配置、定时任务创建流程。

```bash
git clone git@github.com:Dandan044/july-btc-analyzer.git
cat deployment.md
```

---

## 核心能力

| 能力 | 说明 |
|------|------|
| ⏰ 定时报告 | BTC 日报 9:00/21:00 GMT+8 |
| 📊 山寨币扫描 | 每小时扫描 OKX 合约波动最大的山寨币 |
| 🔔 市场警报 | 动态创建规则，监控价位/量/OI/Taker 等触发条件 |
| 💰 实盘交易 | OKX 现货/合约/期权全品种（需 API 凭证） |
| 🔄 周期管理 | 交易周期隔离，持仓同步，自动归档 |

## 任务路由

### BTC 任务

| 任务 | 入口 | 模型 |
|------|------|------|
| 日报任务 | `tasks/daily-report-stage1.md` → stage2/3/4 | `trigger.btc.model` |
| 即时分析 | `tasks/instant-analysis-stage1.md` → stage2/3/4 | `trigger.btc.model` |
| 设定警报 | `tasks/set-alert.md` | 默认 |

### 山寨币任务

| 任务 | 入口 | 后续阶段 | 模型 |
|------|------|---------|------|
| Scanner 扫描 | `tasks/alt-intel-stage1.md` | stage2 → stage3 → stage4 | `trigger.altcoin.model` |
| 警报即时分析 | `tasks/alt-instant-stage1.md` | alt-intel-stage2 → stage3 → stage4 | `trigger.altcoin.model` |

> **模型配置中心**：`tasks/global-config.json` — 所有 spawn / cron / 警报规则的模型参数统一从此文件读取。
> - BTC → `deepseek-v4-pro`（分析深度优先）
> - 山寨币 → `deepseek-v4-flash`（速度成本优先）

## 山寨币分析链路 🆕

两条触发路径，均 spawn 独立子会话，fire-and-forget 执行四阶段：

```
路径一：定时扫描（每小时）
  altcoin-scanner cron → 扫描最大波动山寨币 → spawn 子会话 → 四阶段

路径二：警报触发（实时）
  警报引擎触发 → 一次性 cron job → spawn 子会话 → 四阶段
```

四阶段流程：`三维情报收集 → 交叉验证 → 仓位管理 → 警报管理`

每个币种独立周期目录：`active/alt-{COIN}-{时间}/`

---

## 架构

```
july-btc-analyzer/
├── active/                     # 活跃周期
│   ├── cycle-YYYYMMDD-XXX/     # BTC 周期
│   └── alt-{COIN}-{时间}/      # 山寨币周期
├── archived/                   # 已归档周期
├── data/                       # 原始 JSON（当天覆盖）
├── logs/                       # 执行日志
├── tasks/                      # 任务规则文件
│   ├── global-config.json      # ⭐ 全局参数（模型/周期上限）
│   ├── daily-report-stage*.md  # BTC 四阶段
│   ├── instant-analysis-*.md   # BTC 即时分析
│   ├── alt-intel-stage*.md     # 山寨币四阶段
│   ├── alt-instant-stage1.md   # 山寨币即时分析入口
│   ├── alt-scanner.md          # 山寨币扫描器
│   ├── set-alert.md            # 警报规则创建指南
│   └── sync-positions.md       # 持仓同步
├── skills/
│   ├── btc-market-lite/        # 市场数据（OKX CLI + API）
│   └── btc-alert/              # 警报器引擎
│       ├── engine.js           # PM2 托管引擎
│       ├── rules/              # 活跃规则（21个）
│       └── rules-archive/      # 已归档规则（gitignored）
└── scripts/                    # 辅助脚本
```

## 数据源

| 数据 | API | 说明 |
|------|-----|------|
| 多币种价格/K线 | OKX CLI | 任意 USDT 合约对，`--coin` 切换 |
| 技术指标 | OKX CLI | RSI/MACD/BB/EMA 服务端计算 |
| 持仓量/多空比/Taker | OKX Rubik API | 动态 `ccy` 参数 |
| 恐惧贪婪 | alternative.me | 仅 BTC |
| 链上数据 | OnchainOS CLI | 山寨币持有人/集群/风险分析 |

## 数据脚本

```bash
cd skills/btc-market-lite/scripts

# BTC 增强分析
node get_enhanced_analysis.js --save

# 山寨币即时数据
node get_instant_data.js --coin ZEC --json --save
node get_altcoin_analysis.js --coin DASH --save
```

## 警报器系统

七月根据分析结论动态创建警报规则，引擎每 3 分钟检查一次。

### 规则接口

| 方法 | 返回 | 说明 |
|------|------|------|
| `check()` | boolean | 触发条件检测 |
| `collect()` | object | 收集触发数据 |
| `trigger(data)` | void | 创建一次性 cron，spawn 子会话分析 |
| `lifetime()` | `'active'\|'expired'\|'completed'` | 生命周期管理 |

### 支持的警报维度

| 维度 | 说明 |
|------|------|
| 多价位监控 | ≤6 价位批量监控，延迟确认防假突破 |
| 成交量异动 | 1h 成交量 vs 均值倍数 |
| OI 变化 | 持仓量涨跌幅度 |
| Taker 买卖比 | 主力资金方向 |
| 定时器 | 纯时间触发 |

### PM2 管理

```bash
pm2 list              # 查看 btc-alert 状态
pm2 logs btc-alert    # 实时日志
pm2 restart btc-alert # 重启引擎
```

---

## 更新日志

### v7 — 2026-05-07
> 🏗️ 山寨币分析链路上线 + 模型配置全局化

- **山寨币分析链路**：两条触发路径（Scanner 定时扫描 + 警报即时分析），四阶段流程，每币种独立周期目录
- **全局模型配置**：`tasks/global-config.json` 统一管理所有 spawn/cron/警报规则的模型参数（BTC→pro，山寨币→flash）
- **AGENTS.md 重构**：拆分为 BTC / 山寨币 双分支，Spawn 指令全部引用 config
- **set-alert.md 模板升级**：新规则自动 `require(global-config)` + `COIN` 变量，模型根据币种自动选择
- **警报规则全量更新**：21 个活跃规则全部改用 config 引用，0 硬编码
- **旧系统清理**：移除 `alerts/`（旧预警系统）、`rules/archive/`（129个旧规则）、实验脚本和 .bak 文件
- **.gitignore 更新**：覆盖 `active/alt-*/`、`archived/alt-*/` 山寨币周期目录

### v6 — 2026-05-03
> 🌐 多币种数据脚本：`--coin` 参数 + 动态自适应 + 健壮性增强

- 数据脚本支持 `--coin` 参数，任意 OKX USDT 合约对
- 价格精度 11 层阶梯自适应、清算分档 8 层阶梯
- Spot→Swap 双重回退、Deribit 期权仅 BTC/ETH
- 修复 `parseInt` 截断小数分档键的 bug

### v5 — 2026-04-19 ~ 2026-04-26
> 🏗️ 四阶段日报架构 + 多价位警报 + 交易系统重构

- 四阶段流水线（数据→分析→仓位→警报），每阶段独立子会话
- 多价位监控（≤6价位打包），K线区间防瞬时突破
- 实盘持仓同步系统（`positions.json`）
- 斐波那契、期权数据压缩、SOUL.md 人格定义
- 数据脚本 API 调用减半（日报 7→4次，即时 9→6次）

### 早期版本（2026-02-27 ~ 2026-04-14）
详见 git log。包括：警报器引擎、交易周期系统、OKX 实盘集成、期权数据、斐波那契分析、多空比/Taker/持仓量数据源、飞书分发架构等。

---

*创建于 2026-02-27 · 由 OpenClaw 驱动*
