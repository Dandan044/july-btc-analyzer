# 山寨币广撒网工作流 · 架构设计

> 设计日期：2026-05-03
> 状态：设计定稿，待实现

---

## 一、核心理念

```
BTC 工作流  = 精准狙击              山寨币工作流 = 广撒网捕鱼
  深研一个标的                        每小时扫描异动币
  等待最佳时机                        发现即分析、分析即行动
  标准仓位、紧止损                    低仓位、宽止损、靠赔率×胜率取胜
```

山寨币市场由独立资金操控，涨幅榜前列币种往往不再跟随 BTC。因此分析维度需要扩展到：媒体消息 + 链上数据 + 合约技术面，三维交叉验证。

---

## 二、整体架构

```
                    ⏰ Cron: 每小时触发
                          │
             ┌────────────▼────────────┐
             │    山寨币扫描引擎          │
             │    tasks/alt-scanner.md  │
             │                          │
             │  获取 OKX 合约涨幅榜 #1   │
             │  获取 OKX 合约跌幅榜 #1   │
             │  ┌────────────────────┐  │
             │  │  查重引擎           │  │
             │  │  · coin X 已有活跃  │  │
             │  │    周期？→ 顺延下一位│  │
             │  │  · 最近24h已扫描？  │  │
             │  │    → 顺延           │  │
             │  └────────────────────┘  │
             │                          │
             │  新币种 → spawn 独立分析  │
             └──────────────────────────┘
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐
   │  DOGE    │  │  PEPE    │  │  WIF     │
   │  独立周期 │  │  独立周期 │  │  独立周期 │
   │          │  │          │  │          │
   │ A→B→C→D │  │ A→B→C→D │  │ A→B→C→D │
   │ 独立警报 │  │ 独立警报 │  │ 独立警报 │
   │ 独立日志 │  │ 独立日志 │  │ 独立日志 │
   └──────────┘  └──────────┘  └──────────┘
       互不干扰，各自运行，各自归档
```

---

## 三、文件结构（与 BTC 工作流合并复用）

```
july-btc-analyzer/                          ← 根目录不变
│
├── active/                                 ← 全部活跃周期共存
│   ├── cycle-20260503-001/                 ← BTC 周期
│   │   ├── data-context/                   ← 数据清单
│   │   │   ├── data-manifest-*.json
│   │   │   └── data-mining-*.md
│   │   ├── positions.json                  ← BTC 持仓
│   │   └── reports/                        ← BTC 报告
│   │       └── btc-report-*.md
│   │
│   ├── alt-DOGE-20260503-1200/             ← 山寨周期
│   │   ├── data-context/
│   │   ├── positions.json                  ← 该币专属持仓
│   │   └── reports/
│   │       └── alt-report-*.md
│   │
│   └── alt-PEPE-20260503-1300/             ← 同时活跃，互不干扰
│       └── ...
│
├── archived/                               ← 全部已归档周期
│   ├── cycle-20260429-002/                 ← BTC 归档
│   └── alt-SHIB-20260502-0800/             ← 山寨归档
│
├── data/                                   ← 数据文件（脚本已支持 --coin 参数化）
│   ├── 2026-05-03.json                     ← BTC 数据
│   ├── DOGE-2026-05-03.json                ← 山寨数据（COIN-日期.json）
│   └── PEPE-2026-05-03.json
│
├── tasks/                                  ← 全部任务规则
│   ├── daily-report-stage1.md              ← BTC（不变）
│   ├── daily-report-stage2.md
│   ├── daily-report-stage3.md
│   ├── daily-report-stage4.md
│   ├── instant-analysis-stage1.md
│   ├── set-alert.md
│   ├── sync-positions.md
│   │
│   ├── alt-scanner.md                      ← 🆕 每小时扫描引擎
│   ├── alt-intel-stage1.md                        ← 🆕 阶段A：三维信息收集
│   ├── alt-intel-stage2.md                 ← 🆕 阶段B：交叉验证
│   ├── alt-intel-stage3.md                 ← 🆕 阶段C：实盘执行
│   └── alt-intel-stage4.md                        ← 🆕 阶段D：警报管理
│
├── skills/
│   ├── btc-market-lite/                    ← 共用数据脚本（已支持 --coin）
│   │   ├── scripts/get_enhanced_analysis.js    ← --coin DOGE
│   │   ├── scripts/get_instant_data.js         ← --coin PEPE
│   │   └── scripts/api.js                      ← 通用 OKX API
│   │
│   └── btc-alert/
│       ├── engine.js                       ← 共用警报引擎
│       ├── rules/                          ← 全部活跃规则（BTC+山寨混合）
│       │   ├── 2026-05-03-bb-breakout.js   ← BTC 规则
│       │   ├── DOGE-funding-extreme.js     ← 山寨规则（靠命名区分）
│       │   └── PEPE-breakout.js
│       │
│       └── rules-archive/                  ← 全部归档规则（BTC+山寨混合）
│           ├── 2026-04-20-support-*.js     ← BTC 归档
│           └── SHIB-support-70000.js       ← 山寨归档
│
├── scripts/                                ← 全部脚本（不变）
│   ├── okx-proxy.sh                        ← 通用交易代理
│   └── ...
│
├── logs/                                   ← 按后缀区分
│   ├── btc-alert.log                       ← BTC 警报引擎日志（不变）
│   ├── daily-report-process.log            ← BTC 日报进程日志（不变）
│   │
│   ├── alt-scanner.log                     ← 🆕 扫描引擎日志
│   │
│   ├── alt-DOGE-process.log                ← 🆕 DOGE 四阶段进程日志
│   ├── alt-DOGE-alert.log                  ← 🆕 DOGE 警报日志
│   │
│   ├── alt-PEPE-process.log                ← 🆕 PEPE 四阶段进程日志
│   └── alt-PEPE-alert.log                  ← 🆕 PEPE 警报日志
│
└── alt-state.json                          ← 🆕 扫描查重状态
```

---

## 四、命名规范

| 类型 | 规则 | 示例 |
|------|------|------|
| **BTC 周期目录** | `cycle-YYYYMMDD-NNN` | `cycle-20260503-001` |
| **山寨周期目录** | `alt-{COIN}-YYYYMMDD-HHMM` | `alt-DOGE-20260503-1200` |
| **BTC 数据文件** | `YYYY-MM-DD.json` | `2026-05-03.json` |
| **山寨数据文件** | `{COIN}-YYYY-MM-DD.json` | `DOGE-2026-05-03.json` |
| **BTC 警报规则** | `YYYY-MM-DD-{描述}.js` | `2026-05-03-bb-breakout.js` |
| **山寨警报规则** | `{COIN}-{描述}.js` | `DOGE-funding-extreme.js` |
| **BTC 进程日志** | `daily-report-process.log` | 保持不变 |
| **山寨进程日志** | `alt-{COIN}-process.log` | `alt-DOGE-process.log` |
| **BTC 警报日志** | `btc-alert.log` | 保持不变 |
| **山寨警报日志** | `alt-{COIN}-alert.log` | `alt-DOGE-alert.log` |
| **扫描日志** | `alt-scanner.log` | 唯一扫描引擎日志 |

> **命名区分性**：BTC 和山寨通过前缀天然区分。BTC 规则以日期开头、山寨规则以币名开头，在 rules/ 和 rules-archive/ 中不会碰撞。

---

## 五、复用关系

```
┌─────────────────────────────────────────────────────────┐
│                    共用层（已存在，零改动）                  │
│                                                          │
│  skills/btc-market-lite/scripts/                         │
│  ├─ get_enhanced_analysis.js    ← --coin DOGE           │
│  ├─ get_instant_data.js         ← --coin PEPE           │
│  └─ api.js                      ← 通用 OKX API          │
│                                                          │
│  skills/btc-alert/engine.js     ← 同一引擎               │
│  skills/btc-alert/rules/        ← BTC+山寨混合           │
│  skills/btc-alert/rules-archive/← BTC+山寨混合           │
│  scripts/okx-proxy.sh           ← 同一代理               │
│  OKX 交易 API                   ← --instId 参数化        │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   ┌────────────┐       ┌──────────────┐
   │ BTC 专用    │       │ 山寨币专用     │
   │            │       │              │
   │ tasks/     │       │ tasks/       │
   │ daily-*.md │       │ alt-*.md     │
   │            │       │              │
   │ active/    │       │ alt-state.   │
   │ cycle-*    │       │ json         │
   │            │       │              │
   │ data/      │       │ active/      │
   │ YYYY-MM-   │       │ alt-COIN-*   │
   │ DD.json    │       │              │
   │            │       │ data/        │
   │ logs/      │       │ COIN-YYYY-   │
   │ btc-*.log  │       │ MM-DD.json   │
   │ daily-*.log│       │              │
   │            │       │ logs/        │
   │            │       │ alt-*.log    │
   └────────────┘       └──────────────┘
```

---

## 六、单币四阶段流程

每个被扫描命中的山寨币，spawn 一个独立子会话，走完整四阶段：

### 阶段 A：三维信息收集 (`alt-intel-stage1.md`)

| 维度 | 数据源 | 具体内容 |
|------|--------|---------|
| **媒体搜索** | `web_search` | 项目进展、合作公告、CEX上线、社区热度、鲸鱼动向 |
| | 信源 | Coindesk / Cointelegraph / The Block / Decrypt / X |
| | 时效过滤 | >7天的消息视为噪音，忽略 |
| **链上数据** | 区块链浏览器 | 头部持仓集中度、交易所净流入/流出、大额转账、活跃地址数 |
| **合约技术** | OKX 脚本 | `--coin {COIN}` 获取价格/K线/OI/资金费率/多空比/Taker比 |

### 阶段 B：交叉验证 (`alt-intel-stage2.md`)

```
正向信号权重叠加（做多判断）：
  ├─ 媒体：利好催化 +1
  ├─ 链上：聪明钱流入 +1
  ├─ 技术：突破结构 +1
  └─ 3/3 = 高置信度做多

负向信号（做空判断）：
  ├─ 媒体：FUD/利空 +1
  ├─ 链上：交易所大量转入 +1
  ├─ 技术：破位 + 资金费率极高 +1
  └─ 3/3 = 高置信度做空

信号模糊（1-2个信号）→ 观望，不交易
```

### 阶段 C：实盘执行 (`alt-intel-stage3.md`)

| 参数 | 规则 |
|------|------|
| 单笔仓位 | 小仓位（比BTC标准仓位小数倍） |
| 止损 | 宽止损（容忍山寨高波动） |
| 止盈 | 阶梯式分批获利 |
| 杠杆 | 低杠杆或不使用 |
| 执行 | OKX 合约下单 → 止损条件单 → 止盈条件单 |

### 阶段 D：警报管理 (`alt-intel-stage4.md`)

为此币种创建专属警报规则（写入 `skills/btc-alert/rules/`）：
- 跟踪止盈触发
- 趋势反转预警
- 资金费率极端值
- OI 异常变化
- 链上大额异动

警报触发 → 重新评估 → 调整/平仓
全部平仓 → 周期归档（active → archived，规则 → rules-archive）

---

## 七、扫描引擎设计

### `alt-state.json` 结构

```json
{
  "scanner": {
    "last_run": "2026-05-03T13:00:00+08:00",
    "run_interval_min": 60
  },
  "active_coins": {
    "DOGE": {
      "cycle_dir": "alt-DOGE-20260503-1200",
      "spawned_at": "2026-05-03T12:00:00+08:00"
    }
  },
  "scanned_24h": {
    "SHIB": "2026-05-03T11:00:00+08:00",
    "FLOKI": "2026-05-03T10:00:00+08:00"
  },
  "permanent_skip": ["USDT", "USDC", "DAI", "BTC", "ETH"],
  "max_active_cycles": 8
}
```

### 每小时执行逻辑

```
1. 检查 active_coins 数量 < max_active_cycles
   ├─ 不足 → 继续扫描
   └─ 已满 → 跳过本轮

2. 涨幅榜扫描：
   ├─ 获取 OKX 合约涨幅榜
   ├─ 取 #1 → 查 permanent_skip → 命中？跳过
   ├─ 查 active_coins → 命中？顺延下一位
   ├─ 查 scanned_24h → 命中？顺延下一位
   └─ 全部命中 → 加入 active_coins + scanned_24h → spawn 分析

3. 跌幅榜同理（独立并行）

4. 清理 scanned_24h 中超过 24h 的记录
```

---

## 八、调度设计

| Cron 任务 | 频率 | 目标 | 说明 |
|-----------|------|------|------|
| `btc-daily-report` | 09:00, 21:00 | BTC 四阶段 | 不变 |
| `altcoin-scanner` | 每小时整点 | 山寨扫描引擎 | 🆕 |

每个山寨子周期是 fire-and-forget：
```
spawn(alt-intel) → 完成后自动 spawn(alt-analysis) → alt-execute → alt-alert
```
所有阶段由子会话内部接力，不需要外部调度。

---

## 九、与 BTC 工作流的关键差异

| 维度 | BTC 工作流 | 山寨币工作流 |
|------|-----------|-------------|
| **触发方式** | 定时 9:00 / 21:00 | 每小时扫描异动榜 |
| **标的数量** | 单一 (BTC) | 多币种并发（上限 8） |
| **周期模型** | 串行，一次一个 | 并行，N 个同时运行 |
| **分析框架** | 纯技术面 4 阶段 | 三维交叉验证（媒体+链上+技术） |
| **决策门槛** | 等待高概率机会 | 信号达到阈值即入场 |
| **仓位管理** | 标准仓位，紧止损 | 低仓位，宽止损 |
| **报告频率** | 每天 2 次 | 发现即分析，不等待 |
| **数据源** | OKX + alternative.me | OKX + web_search + 链上 |
| **警报维度** | BTC 价格/指标阈值 | 每币独立，含链上/费率异动 |
| **周期归档** | BTC 报告周期结束 | 每币独立判断归档 |

---

## 十、增量改动清单

### 新增文件

| 文件 | 用途 |
|------|------|
| `tasks/alt-scanner.md` | 每小时扫描引擎规则 |
| `tasks/alt-intel-stage1.md` | 阶段A：三维信息收集 |
| `tasks/alt-intel-stage2.md` | 阶段B：交叉验证决策 |
| `tasks/alt-intel-stage3.md` | 阶段C：实盘执行 |
| `tasks/alt-intel-stage4.md` | 阶段D：独立警报管理 |
| `alt-state.json` | 扫描查重状态持久化 |

### 新增 Cron

| 名称 | 频率 |
|------|------|
| `altcoin-scanner` | 每小时整点 |

### 零改动部分

```
✅ skills/btc-market-lite/     ← 脚本已支持 --coin
✅ skills/btc-alert/engine.js  ← 引擎通用
✅ skills/btc-alert/rules/     ← 靠命名区分，无需新建目录
✅ skills/btc-alert/rules-archive/ ← 同上
✅ scripts/okx-proxy.sh        ← 通用
✅ OKX 交易 API                ← 参数化
✅ tasks/daily-report-stage*.md ← 不受影响
✅ active/cycle-*              ← BTC 周期不受影响
✅ archived/                   ← 归档逻辑不受影响
```

---

## 十一、日志体系

```
logs/
├── btc-alert.log                  ← BTC 警报引擎（PM2服务，不变）
├── daily-report-process.log       ← BTC 日报进程（四阶段，不变）
│
├── alt-scanner.log                ← 扫描引擎（每小时触发记录）
│
├── alt-DOGE-process.log           ← DOGE 周期进程（阶段A→B→C→D）
├── alt-DOGE-alert.log             ← DOGE 警报触发记录
│
├── alt-PEPE-process.log           ← PEPE 周期进程
├── alt-PEPE-alert.log             ← PEPE 警报触发记录
│
└── ...                            ← 更多山寨币同理
```

**日志记录规范**（沿用 BTC 的 ⚠️ WARN / ⛔ ERROR 体系）：

| 级别 | 标识 | 含义 |
|------|------|------|
| 正常 | `[时间] [阶段X]` | 流程节点 |
| 警告 | `[时间] [阶段X] ⚠️ WARN:` | 不影响流程 |
| 错误 | `[时间] [阶段X] ⛔ ERROR:` | 需关注 |

---

*设计定稿。待主人确认后进入实现阶段。*
