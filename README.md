# 七月 📈 - 加密货币技术分析师

> 专注于加密货币技术分析的智能体，每天定时提供市场报告，并可根据分析结果动态创建市场警报。
> 
> **v0.1.4 更新**：市场观测器上线（WebSocket 实时异动检测）+ 镜像机器人共享缓存架构 + Dashboard 紧急清仓归档 + 数据层独立监控 + 持仓全面审视系统 + 周期守护者重构 + 网格压测工具 + 10+ 篇交易复盘。
> 详见 `changelog/` 目录下 2026-06-15 至 2026-06-25 各篇日志。
>
> **v0.1.3**：庄币流程统一重构 + 分析质量三道防线 + BTC 宏观环境感知 + 监督者升级 + 挂单开仓 + 方向承诺机制 + 异动检测引擎 + 阶段三逐仓改造 + 组合暴露度筛选器 + 头仓试探模式。
> 详见 `changelog/` 目录下 2026-05-29 至 2026-06-15 各篇日志。

## 🚀 快速开启

**首次部署请务必阅读 `deployment.md`**，包含完整的 18 步部署清单：
- 智能体注册流程
- 代理配置说明（统一 `PROXY_URL` 环境变量）
- PM2 四大进程（btc-alert / cron-dispatcher / cron-name-cache / july-dashboard）
- OKX CLI + OnchainOS CLI 配置
- OpenClaw 技能安装（`npx skills add okx/agent-skills`）
- 定时任务 + 山寨币扫描 crontab + 市场快报

```bash
# 克隆仓库
git clone git@github.com:Dandan044/july-btc-analyzer.git

# 查看部署指南
cat deployment.md
```

---

## 简介

七月是一个专门负责比特币技术分析的 AI 智能体。他会：

- ⏰ 每天定时触发（9:00 和 21:00 GMT+8）
- 📊 获取市场数据（价格、市值、恐惧贪婪指数）
- 🧠 计算技术指标（SMA、EMA、RSI、动量、波动率）
- 📝 生成分析报告并保存到本地文件
- 🔔 **动态创建市场警报** - 根据分析发现的关键点位
- 🔄 **交易周期管理** - 独立管理每轮交易建议
- 💰 **实盘交易执行** - 通过 OKX CLI 自动执行开仓、止盈、止损

> **报告存储与分发**：
> - 报告保存到 `active/cycle-*/reports/` 目录
> - 文件格式：`btc-report-YYYY-MM-DD-HHMM.md`（日报）或 `instant-report-YYYY-MM-DD-HHMM.md`（即时分析）
> - 可通过外部程序监控此目录的文件更新，实现自定义推送逻辑（如发送到飞书、Telegram、Discord 等）

## 技术栈

### 数据源

| 数据 | API | 说明 |
|------|-----|------|
| 多币种价格/K线 | **OKX CLI** | 支持任意 USDT 合约对，`--coin` 切换（需代理） |
| 技术指标 | **OKX CLI** | RSI/MACD/BB/EMA 服务端计算 |
| 持仓量/多空比/Taker | **OKX Rubik API** | 动态 `ccy` 参数适配多币种 |
| 恐惧贪婪指数 | alternative.me | 仅 BTC，其他币种跳过 |
| 期权数据 | Deribit | 仅 BTC/ETH 支持，其他币种自动跳过 |

> **数据源说明**: OKX 为主力数据源（国内网络需代理），CryptoCompare 用于警报器（国内直连）

### 技术指标

- **SMA** (简单移动平均): 7/14/20/30/50 日
- **EMA** (指数移动平均): 7/12/20/26 日
- **RSI** (相对强弱指标): 14 日
- **波动率**: 30 日标准差
- **斐波那契回调位**: 23.6% / 38.2% / 50% / 61.8% / 78.6%
  - 支持多时间框架：日线 / 4小时 / 周线
  - 自动识别波段高低点并计算关键价位

### 技能

| 技能 | 说明 |
|------|------|
| `btc-market-lite` | 多币种市场数据获取（`--coin BTC/SOL/ETH/LAB...`） |
| `btc-alert` | 灵活的市场警报系统 |

---

## 数据脚本使用 📊

```bash
cd skills/btc-market-lite/scripts

# 默认 BTC 增强分析
node get_enhanced_analysis.js --save

# 多币种切换
node get_enhanced_analysis.js --coin SOL --json --save
node get_enhanced_analysis.js --coin ETH --save
node get_enhanced_analysis.js --coin LAB --save

# 即时分析（多币种）
node get_instant_data.js --coin SOL --json --save

# 山寨币三维分析（合约 + 消息面 + 链上）
node get_altcoin_analysis.js --coin DASH --save
```

### 自适应机制

| 特性 | BTC (~$78k) | SOL (~$84) | LAB (~$3) |
|------|------------|-----------|----------|
| 价格精度 | 2位 | 3位 | 5位 |
| 清算分档 | $500/档 | $5/档 | $0.5/档 |
| 费率周期 | 自动推算(8h) | 自动推算(8h) | 自动推算(4h) |
| 期权数据 | ✅ Deribit | ⛔ 跳过 | ⛔ 跳过 |
| Spot回退 | ✅ | ✅ | ⛔→SWAP |

---

## 交易周期系统 🔄

七月使用**交易周期系统**管理交易建议，实现周期隔离和自动化管理。

### 核心概念

**交易周期（Cycle）** 是七月管理交易建议的核心单位。一个周期从上一篇报告结束开始，到所有交易建议关闭为止。

### 目录结构

```
july-btc-analyzer/
├── active/                      # 活跃交易周期
│   ├── cycle-YYYYMMDD-XXX/      # BTC 周期（最多1个）
│   │   ├── positions.json        # 实盘持仓文件（OKX同步）
│   │   ├── data-context/         # 阶段一产出
│   │   │   ├── data-manifest-*.json  # 数据清单
│   │   │   └── data-mining-*.md      # 数据挖掘报告
│   │   └── reports/             # 本周期报告
│   │       ├── btc-report-YYYY-MM-DD-HHMM.md
│   │       └── instant-report-YYYY-MM-DD-HHMM.md
│   └── alt-{COIN}-{时间}/       # 山寨币周期（最多20个）
│       ├── positions.json        # 山寨币持仓
│       ├── data/                 # 原始数据
│       └── reports/              # 山寨币分析报告
│
├── archived/                    # 已归档周期
│   ├── cycle-YYYYMMDD-XXX/      # BTC 历史周期
│   └── alt-{COIN}-{时间}/       # 山寨币历史周期
│
├── data/                        # 原始 JSON 数据
├── logs/                        # 执行日志
├── scripts/                     # 辅助脚本
├── skills/                      # 技能目录
│   ├── btc-alert/               # 警报器技能
│   │   ├── engine.js            # 警报引擎
│   │   ├── rules/               # 活跃警报规则（BTC + 山寨币）
│   │   └── rules-archive/       # 已归档规则（gitignored）
│   └── btc-market-lite/         # 数据获取技能
│       └── scripts/             # 数据脚本
└── tasks/                       # 任务规则
    └── global-config.json       # ⭐ 全局参数（模型/周期上限）
```

### 周期生命周期

```
[上一周期结束]
      │
      ▼
下一篇报告生成 → 开启新周期（创建 positions.json）
      │
      ▼
周期进行中 → 报告保存到 active/cycle-xxx/reports/
          → 识别操作意图 → 执行交易 → 同步 positions.json
          → 监控止盈/止损触发
      │
      ▼
持仓清空 → 归档（移动 active/ → archived/）
      │
      ▼
[下一周期在下一篇报告时开启]
```

**持仓状态判断：**
- `positions.json` 中 `当前持仓` 为空数组 → 无持仓
- `当前持仓` 有记录 → 持仓中，需监控止盈止损
- 归档条件：持仓数=0 且 `最近平仓` 非空（表示刚完成一轮交易）

### 设计原则

| 原则 | 说明 |
|------|------|
| **周期连续性** | 一周期结束后，下一篇报告立即开启新周期 |
| **文件驱动** | 七月只通过读写文件理解状态，不依赖记忆 |
| **周期隔离** | 归档后七月不读取历史，不受上一轮交易影响 |
| **简洁归档** | 仅移动文件夹，不做总结计算 |
| **无持仓周期支持** | 允许周期内无持仓（纯观望期） |
| **实盘驱动** | 持仓状态由 OKX API 实时同步，而非建议文件管理 |

---

## 警报器系统 🔔

七月可以根据分析结果，动态创建市场警报规则。

### 架构设计

```
七月分析 ──────► 发现关键点位 ──────► 编写警报规则
    ▲                                    │
    │                                    ▼
执行即时分析 ◄─────── 触发通知 ◄─────── 警报器监控
```

### 警报类型

| 警报类型 | 实现思路 | 适用场景 |
|---------|---------|---------|
| **多价位监控** | 单规则支持≤6价位，使用K线区间数据 | 批量监控支撑/阻力位 |
| **价格警报** | 价格 >= 或 <= 目标位 | 单价位监控（较少使用） |
| **定时器警报** | 纯时间判断，无数据依赖 | 计划入场时间提醒、定时检查 |
| **延迟触发警报** | 条件满足后等待N分钟 | 确认突破有效性、避免假突破 |
| **交易量异动** | 小时交易量 > N日均值 × M | 大资金进出 |
| **振幅警报** | 1小时 high-low > 阈值% | 剧烈波动 |
| **OI变化监控** | 持仓量涨跌幅度监控 | 市场情绪变化 |
| **Taker买卖比** | Taker多空比例监控 | 主力资金方向 |

> **多价位优势**（2026-04-26 改造）：单规则打包多个价位，避免筛选丢弃有意义的价格位；使用K线区间而非瞬时价格，捕捉瞬时突破。

### 规则接口

每个警报规则由智能体现场编写，实现4个抽象方法：

| 方法 | 返回 | 说明 |
|------|------|------|
| `check()` | boolean | 检测条件是否满足 |
| `collect()` | any | 收集要传递的数据 |
| `trigger(data)` | void | 触发动作 |
| `lifetime()` | string | 规则状态：active/expired/completed |

### 生命周期管理

- `active` - 规则正常运行
- `expired` / `completed` - 规则自动归档到 `rules-archive/`
- **热更新支持** - 手动移动规则文件到归档目录后，引擎最多 1 分钟内自动卸载该规则

### 日志系统

- `logs/alert-engine.log` - 警报器引擎执行日志
- `logs/alert-setup.log` - 规则设定日志

---

## 配置

### 定时任务

| 任务 | 时间 (GMT+8) | 描述 |
|------|--------------|------|
| btc-daily-report | 09:00 | 早间分析报告 |
| btc-daily-report-2 | 21:00 | 晚间分析报告 |

### 任务路由

当收到任务指令时，读取对应的任务规则文件并严格执行：

#### BTC 任务

| 任务 | 规则文件 |
|------|---------|
| 执行日报任务 | `tasks/daily-report-stage1.md` |
| 设定市场警报 | `tasks/set-alert.md` |
| BTC 即时分析 | `tasks/instant-analysis-stage1.md` |
| 周期健康巡检 | `tasks/cycle-health-check.md` |
| 交易复盘 | `tasks/trade-review.md` |

#### 山寨币任务

| 任务 | 阶段一入口 | 后续阶段 |
|------|-----------|---------|
| Scanner 扫描分析 | `tasks/alt-intel-stage1.md` | stage2 → stage3 → stage4 |
| 警报触发即时分析 | `tasks/alt-instant-stage1.md` | alt-intel-stage2 → stage3 → stage4 |

### 任务触发流程

```
定时任务 ───► 阶段一 ──► 阶段二 ──► 阶段三 ──► 阶段四
（主会话spawn）  ↓        ↓        ↓        ↓
              清单路径  周期目录  状态+路径  警报管理
                            ↓
                      同步持仓

警报触发 ───► 即时分析（阶段一）
```

---

## 部署

### PM2 配置

警报器和报告监控器通过 PM2 托管：

```bash
# 查看状态
pm2 list

# 日志
pm2 logs btc-alert
pm2 logs july-report-monitor
```

当前运行的 PM2 进程：

| 进程名 | 说明 |
|--------|------|
| `btc-alert` | 警报器引擎（BTC + 山寨币） |
| `btc-log-rotate` | 日志轮转（每日 00:10） |

**代理环境变量** (ecosystem.config.js):
```javascript
env: {
  http_proxy: 'http://127.0.0.1:7890',
  https_proxy: 'http://127.0.0.1:7890',
  all_proxy: 'socks5://127.0.0.1:7890'
}
```

---

## 相关智能体

| 智能体 | 关系 | 说明 |
|--------|------|------|
| 一月酱 | 上司 | 管理七月和十四月 |
| 十四月子 | 同事 | QQ机器人，转发七月报告给主人 |

十四月会从 `active/cycle-*/reports/` 读取最新报告并转述。

---

## 更新日志

### 2026-06-25
> 🚀 v0.1.4 — 市场观测器 + 共享缓存架构 + Dashboard 紧急重置 + 数据层独立监控 + 持仓全面审视 + 周期守护者重构

**① 📡 市场观测器上线（`skills/market-watch/`）：**
- WebSocket 驱动的实时市场监控引擎，与旧 `btc-alert` 并行运行
- 主循环（周期扫描 + WS 整合）+ WebSocket 连接管理 + 内存数据存储 + 阈值触发检测 + 异步派发
- 仅监控有持仓的币种 + `alwaysWatch`（BTC），持仓变化时自动订阅/退订
- 与 btc-alert 互补：market-watch 做宏观异动检测，btc-alert 做精准价位监控
- PM2 托管为 `市场脉动` 进程

**② 🪞 镜像机器人共享缓存架构（`scripts/mirror-bot.js`）：**
- 新增 `buildSourceSnapshotFromCache()`：从共享缓存构建源持仓快照，替代独立 OKX API 调用
- 共享缓存写入 `data/okx-positions-cache.json`，Dashboard 和 mirror-bot 共用
- 减少冗余 API 调用，降低 OKX 限流风险
- 持仓同步日志统一到 `logs/mirror-bot.log`

**③ 🔴 Dashboard 紧急清仓归档（`dashboard/public/index.html` + `scripts/cron-dispatcher.js`）：**
- 新增「⚠️ 一键清仓归档」按钮：市价平仓所有实盘仓位 + 归档所有活跃周期 + 归档所有活跃规则 + 删除一次性 cron
- 双重确认机制防止误触
- 调度器新增 `POST /admin/reset-all` 端点：清空队列 + 终止运行中一次性 cron 任务
- market-watch 周期（`mw-{COIN}-{TS}`）分类支持
- 市场简报 JSON 解析容错（跳过损坏文件，遍历直到成功）

**④ 📊 数据层独立监控（`scripts/data-monitor.js`）：**
- 新增数据监控脚本，Dashboard 扫描日志可查看
- 独立于交易流程的数据完整性检查

**⑤ 📋 持仓全面审视系统（`scripts/position-monitor.js` + `tasks/position-monitor.md`）：**
- PM2 常驻进程，每 3h 检查实盘持仓
- 自动派发审计任务：逐仓位盈亏复查 + 市场环境复核 + 决策执行
- 仅当 OKX 实盘持仓 > 0 时触发
- PM2 托管为 `持仓审计` 进程

**⑥ 🛡️ 周期守护者重构（`scripts/cycle-guardian.js`）：**
- 替代旧 `cycle-auto-archiver.js`，更名为「静默巡检-周期清理」
- 增强空周期清理逻辑与日志记录

**⑦ ⚡ 网格压测工具（`scripts/grid-screener.sh` / `grid-screener-v2.sh`）：**
- 自动化网格策略回测与压力测试
- 支持 v2 增强版筛选

**⑧ 📡 Dashboard 扫描日志扩展：**
- 新增「📡 市场观测」和「📡 数据监控」两个日志标签
- 扫描频率新增 5 分钟选项（原仅 15/30/60 分钟）
- 系统 crontab 从每 15 分钟改为每 5 分钟触发 runner

**⑨ 📝 任务文件与流程优化：**
- `tasks/pipeline/modules/` 模块更新：止损仓位计算、交易决策 JSON、警报决策
- `tasks/pipeline/profiles/analysis-alt.md` 精简
- `tasks/pipeline/stage2-alt.md` 大幅精简（-146 行）
- `tasks/alt-intel-stage4.md` 优化警报管理逻辑
- `scripts/stage3-executor.js` / `scripts/calc-portfolio-exposure.js` 微调

**⑩ 📚 交易复盘与教训积累：**
- 新增 12 篇复盘报告：ALLO、BICO、ETH、FIL、LIT、LITE、MU、PIPPIN、PUMP、SOXL、SPX×2、TSLA
- `learnings/PENDING_TRADE_LESSONS.json` 持续积累并精简
- `TOOLS.md` 新增市场观测器、持仓审计、网格压测等速查

**⑪ ⚙️ PM2 进程更新（`ecosystem.config.js`）：**
- 新增：`市场脉动`（market-watch）、`持仓审计`（position-monitor）、`网格压测`（grid-screener）
- 重构：`静默巡检-周期清理`（cycle-guardian 替代 cycle-auto-archiver）
- 移除：`silence-monitor`

**① 🎯 山寨币/庄币流程统一重构（2026-05-30）：**
- 双画像（alt + zhuang）合并为统一 `tasks/pipeline/` 目录，共享模块化阶段二（9 个模块 + JSON 清单组装）
- 删除 `tasks/zhuang-pipeline/`、`tasks/alt-pipeline/` 旧目录及对应脚本
- 新增 `scripts/assemble-stage2.js`：从模块化组件组装阶段二提示词
- 数据刷新 TTL 解耦：持仓/合约/订单簿各自独立刷新周期（2026-05-29）
- 阶段三浮点精度泄露修复：`alignToLot()` 增加 round() 消除 IEEE 754 尾数（2026-05-29）

**② 🛡️ 分析质量三道防线（2026-06-01）：**
- 防线I — 数据可信度：事实型 vs 推测型数据可验证性分层
- 防线II — 自我质疑：bull case + bear case 双轨构建，必须数据完备
- 防线III — 入场方向确认：条件必须是可测量事件，禁止模糊条件

**③ 🌐 BTC 宏观环境感知（2026-06-02）：**
- 新增 `tasks/btc-outlook.md`：BTC 大方向判断流程
- 山寨币分析前先评估 BTC 趋势环境，决定风险敞口
- 指数级对抗：与 BTC 宏观趋势冲突时必须说明理由或降级

**④ 👁️ 监督者升级（2026-06-02 + 2026-06-08）：**
- 新增 `tasks/supervisor-blind.md` + `tasks/supervisor-review.md`：独立评估 + 交叉审查
- 触发条件：开仓/加仓 + 全周期持仓数 > Dashboard 可调阈值
- 冷即机制重构：紧急关停 → 冷即期 + 自动恢复

**⑤ 📊 挂单开仓 + 止盈止损警报链路（2026-06-03）：**
- 开仓从市价单改为限价挂单，在支撑/阻力位挂单入场
- 止盈止损增设独立警报规则：触发后阶段二重新评估

**⑥ 🧭 方向承诺 + 僵尸清理 + 冷即机制（2026-06-03）：**
- 开仓时写入方向承诺（directionCommitment），记录入场逻辑和否定条件
- 僵尸周期自动识别与清理

**⑦ 🔍 异动检测引擎设计（2026-06-05）：**
- 价格 + 成交量 + OI 三维异动检测架构（`docs/p0-implementation-plan-v2.md`）

**⑧ 📐 组合暴露度筛选器（2026-06-07）：**
- 新增 `scripts/calc-portfolio-exposure.js`：BTC 相关度矩阵 × 方向一致性分析
- 同向过度集中触发风险警报

**⑨ 🔧 阶段三逐仓改造（2026-06-07）：**
- 所有交易操作强制逐仓模式，OCO 拆分优化

**⑩ 🧪 头仓试探模式（2026-06-10）：**
- 山寨币首次入场改为小额头仓试探（名义本金 20u），验证通过后加仓

**⑪ 🔔 警报系统分级响应改造（2026-05-28）：**
- 警报按紧急程度分级：critical/warning/info，不同级别触发不同响应策略

**⑫ 📋 新增基础设施：**
- 15 个新脚本（assemble-stage2、benchmark 套件、portfolio-risk-watch、position-monitor、cycle-auto-archiver 等）
- 8 个新任务文件（btc-outlook、pipeline/、position-monitor、supervisor-blind/review 等）
- 3 个新配置文件（altcoin-blacklist、non-alt-list、user-blacklist）
- 80+ 篇复盘报告（覆盖 60+ 币种）

---

### 2026-05-28
> 🔧 v14 — Cron 调度器重构 + 装庄管道上线 + 市场简报系统 + Dashboard 事故修复 + OOM 诊断 + TRADE_LESSONS 自动注入撤销 + 沉默监控 + 复盘报告 18 篇

**① 🔄 Cron 调度器完整重构（`scripts/cron-dispatcher.js` +953行，`scripts/dispatch.js` +150行）：**
- **异步缓存架构**：载荷采集从 `execSync(openclaw cron list)` 阻塞 4-5s → `spawn detached` 每 30s 写缓存文件 + `readFileSync` 8ms
- **动态窗口载荷模型**：固定 5min 窗口 → 基于任务执行时间的窗口重叠检测，运行态精确识别
- **并发控制修复**：修复 `importCronJobs()` 删除 internal 条目导致 6 个 high-1 任务同时涌入 deepseek 池
- **负载跟踪简化**：去重 internal/cron 双条目、修复陈旧 `now` 变量导致已完成任务显示 0m/0m
- **缓存共享**：`data/cron-list-cache.json` 30s 刷新，Dashboard 也从缓存读取（4-5s → 毫秒级）

**② 🎭 装庄管道上线（`tasks/zhuang-pipeline/` + `scripts/scanner-zhuang.py` + `scripts/stage3-executor-zhuang.js`）：**
- 新增独立分析管道：专门追踪疑似庄家控盘币种
- `scanner-zhuang-runner.sh` → `scanner-zhuang.py`（控盘识别筛选）→ `stage1-prep` → `zhuang-intel-stage1-v2.md` → `zhuang-intel-stage2.md` → `stage3-executor-zhuang.js`
- 装庄阶段二独立提示词，侧重庄家成本/动机/计划分析
- 阶段三执行器独立版本，适配装庄策略的仓位管理

**③ 📻 市场简报系统（`tasks/market-brief.md` + `scripts/market-brief-collect.sh` + `scripts/market-brief-process.py`）：**
- 新增定时市场简报收集与处理流程
- 数据采集 → Python 处理 → 报告输出

**④ 🔴 Dashboard 严重事故修复（`changelog/2026-05-24-Dashboard严重事故复盘.md`）：**
- 三层事故链修复：
  1. Dashboard 崩溃循环 — `openclaw cron list` 超时导致 3 分钟 130 次重启
  2. WSL2 网络隔离 — Windows 浏览器无法连接 WSL 服务
  3. `uploadBackground()` 缺少 `async` 关键字 → SyntaxError 导致主脚本全部失效
- 加固 `server.js`：熔断器、全局异常保护、请求超时、`safeExec` 替换裸 `execSync`

**⑤ 🔴 Gateway OOM 诊断与修复（`changelog/2026-05-27-GatewayOOM诊断与修复.md`）：**
- 根因：Dashboard `/api/analysis/jobs` 每 5s 调 `openclaw cron list` + 调度器 30s + 名字缓存 60s = 5-6 次/min
- 每次 JSON.parse 分配大对象，GC 跟不上 → 堆冲到 4GB → OOM 崩溃
- 修复：Dashboard 改读缓存文件，去除高频 CLI 轮询
- 新增系统监控（`scripts/silence-monitor.js` +406行）：检测 Gateway 无响应并自动重启

**⑥ 🚫 撤销 TRADE_LESSONS 自动注入（`changelog/2026-05-27-撤销TRADE_LESSONS自动注入.md`）：**
- 撤销 OpenClaw 源码中 4 处 patch，不再在 agent 唤醒时自动加载 `TRADE_LESSONS.md` 到上下文
- 原因：TRADE_LESSONS 体积持续膨胀，每次唤醒占用大量 token
- 文件本身保留，需手动 `memory_search` 查询

**⑦ 🔧 阶段三执行器持续修复（`scripts/stage3-executor.js` +316行）：**
- OCO 拆分张数对齐 `lotSz`（新增 `alignToLot()` 函数）
- 加仓 `executeAdd()` 修复：取消旧 OCO → 加仓 → 加权均价算偏移 → 总仓位设新 OCO
- 减仓 `executeReduce()` 修复：取消旧 OCO → 减仓 → 原始均价算偏移 → 剩余仓位设新 OCO
- 新增 `extractOcoPrices()` 兜底函数：从旧 OCO 算法单提取 SL/TP
- OKX 命令退避重试（`retries=2`, `baseDelayMs=2000`）

**⑧ 🔇 沉默监控（`scripts/silence-monitor.js` +406行）：**
- PM2 常驻进程，检测 Gateway 无响应并自动重启
- 健康检查 + 超时重启 + 通知机制

**⑨ 📋 复盘报告 18 篇（`learnings/review-*.md`）：**
- BTC: 3 篇（5/25、5/27、5/28）
- 山寨币: 15 篇（ARKM、AVNT、AZTEC、BABY、EDGE、JTO、LIT、MERL、MORPHO、MUBARAK、PNUT、SAHARA、STRK、TON、VIRTUAL、WLFI、XPL）
- `learnings/PENDING_TRADE_LESSONS.json` 持续积累待审核行为模式

**⑩ 📝 其他变更：**
- `TRADE_LESSONS.md` 新增/更新多条行为模式
- `TOOLS.md` 新增 Cron 调度器、Dashboard、GitHub SSH 等速查
- `ecosystem.config.js` 新增 `cron-dispatcher` 和 `silence-monitor` PM2 进程
- `tasks/cycle-health-check.md` 优化健康检查逻辑
- `tasks/set-alert.md` 更新警报模板
- `changelog/` 新增 7 篇变更记录
- `.gitignore` 排除 `.trash/`、`market-brief/`、`images/`、`dashboard/public/images/`

---

### 2026-05-24
> 🔧 v13 — Dashboard 2.0 + 阶段三阻拦逻辑移除 + 警报引擎并发控制 + 合约数据退避重试 + OCO 管理修复

**变更内容（基于 v12 增量）：**

**① 🎨 Dashboard 2.0 大改版（`dashboard/public/index.html` +2733行，`dashboard/server.js` +1127行）：**
- **设置面板**：新增 `GET/POST /api/settings` 端点，持久化 dashboard 配置到 `data/dashboard-settings.json`
- **扫描器上限仪表盘可控**：新增 `scannerLimit` 字段（默认45），scanner 启动时从 settings 动态读取
- **背景图片/视频上传**：`POST /api/settings/background` + `DELETE /api/settings/background`，支持 50MB 以内图片/视频，multer 文件管理
- **警报缓存窗口扩大**：最近触发警报从 6h → 24h，grep 从 `tail -200` → `tail -1000`
- **静态资源缓存策略强化**：`Cache-Control: no-store, no-cache, must-revalidate` 禁止浏览器缓存
- **toast 通知系统优化**

**② 🔧 阶段三执行器重构（`scripts/stage3-executor.js` +367行）：**
- **移除全部预设阻拦逻辑（4处）**：
  - 方向冲突拦截移除：`hasPosition && direction !== positionDirection` 不再 skip → 阶段二知道当前持仓，反方向开仓有它的理由
  - 20u 下限移除：`nominalFinal < 20` 不再终止 → 阶段二决定名义值，脚本不设下限
  - 余额检查移除：`available < 5 USDT` 不再预判 → 余额不足让 OKX 报错
  - 只保留阶段二决策输入（`reject_reason`/`hold`/`entry_condition`/逻辑不可能操作）
- **OKX 命令退避重试**：`runOkxCmd()` 新增 `retries=2`、`baseDelayMs=2000`，自动识别网络错误（ETIMEDOUT/ECONNRESET/EPIPE 等）并重试，关键操作（持仓确认）额外配置 `retries=3`
- **OCO 拆分张数对齐 lotSz**：新增 `alignToLot()` 函数，`floor(v/lotSz)*lotSz`，修复 SAHARA（lotSz=1）等币种拆分精度错误
- **加仓 `executeAdd()` 修复**：取消旧 OCO → 加仓 → 加权均价算偏移 → 总仓位设新 OCO（旧逻辑：未取消旧单、按加仓量设 OCO、用 lastPrice）
- **减仓 `executeReduce()` 修复**：取消旧 OCO → 减仓 → 原始均价算偏移 → 剩余仓位设新 OCO（旧逻辑：未取消旧单、用 lastPrice）
- **新增 `extractOcoPrices()` 兜底函数**：从旧 OCO 算法单中提取 SL/TP 价格，阶段二未传参时直接复用
- **双模式 TP/SL 选择**：A 模式（阶段二传参→calcPnlOffset 偏移） / B 模式（兜底复用旧 OCO 价格，不二次偏移）
- **空 `entry_condition` 不再阻塞**：`entry_condition && entry_condition !== 'immediate'` 防止 null 值误判

**③ 🚦 警报引擎并发控制（`skills/btc-alert/engine.js` +121行）：**
- **并发门控**：新增 `MAX_CONCURRENT_CHECKS=3`、`acquireSlot()`、`releaseSlot()`，最多 3 条规则同时执行 API 调用，超出的排队等待
- **429 误判修复**：`isNetworkError()` 新增 `/Too Many Requests/i` 模式，429 现在直接走引擎层自动翻倍间隔，不再走自愈 spawn 流程
- **`runRule()` 改造**：`check()`/`collect()`/`trigger()` 全部包裹在 `acquireSlot()...releaseSlot()` 中

**④ 🔄 合约数据退避重试（`scripts/stage1-prep.js` +43行，`scripts/stage1-instant.js` +47行）：**
- 两个脚本均新增三级退避重试：10s → 20s → 60s（共 4 次尝试）
- 超时从 30s 提升，重试日志带尝试次数标注
- stage1-instant 重构为 for 循环 + break 模式（原为 try-catch 单次）

**⑤ ⏱️ 多价位警报规则优化（`scripts/stage4-executor.js` + `tasks/set-alert.md`）：**
- K 线粒度从 `1m` 升级为 `5m`（减少 OKX API 调用量）
- `limit` 从硬编码 `3` 改为 `Math.max(2, Math.round(this.interval / BAR_MS))`，间隔翻倍时自动缩放
- 默认检测间隔从 `3min` 提升至 `10min`（降低引擎负载）
- set-alert.md C2 约束同步更新

**⑥ 📊 扫描器上限动态化（`scripts/scanner-full.py` + `tasks/alt-scanner.md` + `tasks/global-config.json`）：**
- `MAX_ALT_COINS` 从硬编码 `30` 改为从 `data/dashboard-settings.json` 动态读取 `scannerLimit`，缺省 `45`
- `maxAltcoinCycles` 从 `30` 提升至 `45`
- alt-scanner.md 所有上限引用同步更新

**⑦ ⚙️ PM2 配置更新（`ecosystem.config.js` +16行）：**
- 新增 `cron-name-cache` 进程（`scripts/cron-name-cache.js`），autorestart，max 5 次重启

**⑧ 📋 复盘经验新增（`learnings/PENDING_TRADE_LESSONS.json` +30行）：**
- 「滞后入场（行情已走>70%）应等待回调入场而非追入」— INJ 做多入场@5.346（行情已走90%），止损触发 -7.4%
- 「OI 增长的方向性含义必须与价格行为绑定解读」— OI+31% 被误读为新多头信号，实际是空头增仓
- INJ 复盘报告：`learnings/review-INJ-20260524-1329.md`

**⑨ 📝 阶段二文档补充（`tasks/alt-pipeline/alt-intel-stage2.md` +10行）：**
- 新增「加仓/减仓 TP/SL 语义」表格：`add` 面向总仓位，`reduce` 面向剩余仓位
- 兜底机制说明：阶段二未传 TP/SL 时阶段三从旧 OCO 提取复用

**⑩ 🧹 TOOLS.md 维护（+17/-1行）：**
- 新增陷阱「OCO 拆分张数必须对齐 lotSz」含 SAHARA 案例
- 脚本索引新增 `sync-alt-positions.js`，移除 `multi_timeframe_fib.py`

**⑪ 📄 事件记录：**
- `changelog/2026-05-23-警报器429误判与并发控制.md`
- `changelog/2026-05-23-阶段三阻拦逻辑移除与加仓减仓OCO管理修复.md`
- `changelog/2026-05-23-阶段二开单率分析与激进版创建.md`（上一commit内容）
- `changelog/2026-05-24-Gateway-OOM崩溃记录.md`（仅记录，未修复）

---

### 2026-05-22
> 🔧 v12 — 警报引擎死循环修复 + 非价格规则全类型实现 + 阶段二双视角框架 + 模型统一

**变更内容（基于 v11 增量）：**

**① 🔥 警报引擎死循环修复（`skills/btc-alert/engine.js`）：**
- 根因：KAITO OI 警报 check() 通过 → log TRIGGERED → collect() 崩溃（`${current_oi}` 未定义变量引发 ReferenceError）→ 归档和冷却均不可达 → 规则死循环触发
- 修复：collect()/trigger() 包裹 try-catch，区分代码bug与网络错误
  - ReferenceError / TypeError → 立即 `archiveRule()` 标记 `trigger_collect_error` 终止循环
  - 网络错误 → 走正常错误处理（调整间隔，不归档）
- 新增 `trigger-collect-error` 归档来源枚举

**② 📜 非价格规则全类型完整实现（`scripts/stage4-executor.js`）：**

| 规则类型 | 之前 | 之后 |
|---------|------|------|
| `funding-reversal` | ❌ 存根（return false） | ✅ 完整：OKX 资金费率 API + 阈值比较（above/below/absolute）|
| `taker-ratio` | ❌ 存根 | ✅ 完整：OKX Taker 买卖比 API + 1H 数据 + 方向比较 |
| `ls-reversal` | ❌ 存根 | ✅ 完整：OKX 多空账户比 API + 阈值比较 |
| `volume-anomaly` | ❌ 存根 | ✅ 完整：24H 1H K线成交量 vs 前23根均量比值 |
| `oi-monitor` | ✅ 已有（百分比）| ✅ 新增 `threshold_type: 'absolute'` 模式（直接 OI 合约张数）|
| `oi-monitor` (pct 模式) | ✅ | ✅ check/collect 逻辑简化，新增 `{current_oi}` 占位符 |

每类型包含完整的 check()（实时数据获取+阈值比较+日志）和 collect()（触发数据采集+格式化输出）。

**③ 🔒 阶段四模板注入安全修复（`scripts/stage4-executor.js`）：**
- 根因：`significance_template` 中 `${current_oi}` 未被转义 → 注入生成的 JS 模板字面量 → ReferenceError
- 修复：写入文件前对 rawTemplate 执行 `replace(/\$/g, '\\$')`、反引号转义等
- 同时修复了两处模板字符串错误：`${this.name}` 和 `${err.message}` 原为字面量字符串，现改为表达式

**④ 🧠 阶段二提示词重构（`tasks/alt-pipeline/alt-intel-stage2.md`）：**
- **新增核心铁律「永不放弃交易」**：高度控盘是信号而非禁令，任何市场条件下都必须找到可操作交易方向
- **新增双视角思维框架**：
  - 庄家视角：控盘方的成本/动机/计划
  - 散户视角：市场情绪/仓位拥挤/心理关口
  - 两视角交汇 → 交易机会
- **删除「强庄检测与自动拉黑」步骤**（步骤8整段移除）
- 拉黑机制从阶段二自动执行改为仅保留 `config/altcoin-blacklist.json` 供参考
- 步骤重编号：8→8, 9→8, 10→9
- 新增「⚠️ 非价格规则能力边界（必读）」详细参数说明表
- 术语调整：「庄家操作痕迹」→「价格操纵痕迹」

**⑤ 🔄 模型统一（`tasks/global-config.json` + 上一commit）：**
- BTC 日报/即时分析模型：`deepseek/deepseek-v4-pro` → `deepseek/deepseek-v4-flash`
- 自愈诊断模型：`deepseek/deepseek-v4-pro` → `deepseek/deepseek-v4-flash`
- 全部模型统一为 flash，移除 pro 的差异化配置

**⑥ 📋 复盘经验新增（`learnings/PENDING_TRADE_LESSONS.json`）：**
- 新增：「持仓分析中短期信号与中期信号冲突时应优先服从中期信号」
  - 1h Taker 比回升 + 4h Taker 比 < 1 = 短期技术性反弹，不是趋势反转
  - 持仓管理优先参考 4h 及以上信号，1h 仅影响执行节奏
- 来源：BTC cycle-20260520-001 复盘

**⑦ 📝 Dashboard 路由重排（`dashboard/server.js`）：**
- GET/POST/DELETE `/api/cron/system` 端点从文件末尾移至靠近顶部的 PM2 端点之后
- 功能无变化，代码组织优化

---

> 🤖 **v11 更新**（同日，较早提交）— 山寨币流程脚本化重构 + Dashboard PM2/系统Crontab 控制 + API 参数防错位检测 + 交易教训库扩展

**① 山寨币分析流程脚本化重构（最大变更）：**
- 新架构：`scanner-runner.sh`（纯脚本）完成扫描→预处理→派发，LLM 仅参与 sentiment 收集 + 交叉验证分析
- 两条入口（定时扫描 + 警报触发）汇入同一套 stage2/stage3/stage4
- 定时扫描：`scanner-runner.sh` → `scanner-full.py` 扫描命中 → `stage1-prep.js` 预处理（上线→周期→持仓→合约→报告）→ cron 派发 LLM
- 警报触发：`trigger()` → `stage1-instant.js` 采集即时数据 → cron 派发 LLM
- LLM 会话：读 `alt-intel-stage1-v2.md`（sentiment收集）→ `gen-stage1-manifest.js`（数据清单）→ 读 `alt-intel-stage2.md`（交叉验证+报告+trade-decision.json+alert-candidates.json）
- stage3/stage4 纯脚本执行（`stage3-executor.js` / `stage4-executor.js`），LLM 不再参与
- 所有脚本禁止重写，通过 `tasks/alt-pipeline/` 任务文件驱动

**② 新增脚本工具（10个）：**
| 脚本 | 用途 |
|------|------|
| `scripts/scanner-runner.sh` | 山寨币扫描总调度（Linux cron 每小时触发） |
| `scripts/scanner-full.py` | OKX 合约市场扫描，筛选波动最大的山寨币 |
| `scripts/stage1-prep.js` | 扫描命中后预处理（上线检查→周期创建→持仓同步→合约数据→报告） |
| `scripts/stage1-instant.js` | 警报触发后即时数据采集（解析警报→定位周期→同步持仓→合约数据） |
| `scripts/gen-stage1-manifest.js` | 生成数据清单 JSON（stage1 完成后的交接文件） |
| `scripts/stage3-executor.js` | 仓位执行引擎（读取 trade-decision.json → 执行开仓/止盈止损 → 同步持仓） |
| `scripts/stage4-executor.js` | 警报规则引擎（读取 alert-candidates.json → 写入 alerts/set-alert.md 模板 → 校验归档） |
| `scripts/sync-alt-positions.js` | 山寨币持仓同步（从 OKX API 同步到 positions.json） |
| `scripts/non-alt-classifier.py` | 非山寨币分类器（识别并过滤非目标币种） |
| `scripts/_fix_triggers.js` | 警报触发器修复工具（一次性维护脚本） |

**③ 新增任务文件：**
- `tasks/alt-pipeline/` 目录（山寨币流程标准化任务文件）
  - `alt-intel-stage1-v2.md` — 阶段一：三维信息收集（合约数据 + sentiment + 链上数据）
  - `alt-intel-stage2.md` — 阶段二：交叉验证分析 + trade-decision.json + alert-candidates.json
  - `alt-intel-sentiment.md` — 消息面收集指南
  - `README.md` — 山寨币流程文档

**④ AGENTS.md 山寨币流程更新：**
- 山寨币扫描链路从 `sessions_spawn` 方式改为 `scanner-runner.sh` 纯脚本调度
- 新增「警报触发即时分析」链路说明：`trigger() → stage1-instant.js → cron → LLM`
- 明确标注两条入口汇入同一套 stage2/stage3/stage4
- LLM 职责收窄为仅 sentiment 收集 + 交叉验证分析，其余全部脚本化

**⑤ Dashboard 监控面板增强：**
- 新增 **PM2 进程控制面板**：在线状态、CPU/内存、重启/停止/启动操作
  - `POST /api/pm2/list` — 获取 PM2 进程列表
  - `POST /api/pm2/:action` — 控制 PM2 进程（restart/stop/start）
- 新增 **系统 Crontab 管理面板**：查看/运行/暂停/恢复/删除 crontab 条目
  - `GET /api/cron/system` — 读取系统 crontab
  - `POST /api/cron/system/run` — 手动触发 crontab 命令
  - `POST /api/cron/system/toggle` — 暂停/恢复 crontab 条目（`#PAUSED:` 前缀机制）
  - `DELETE /api/cron/system` — 删除 crontab 条目
- 新增 **Toast 通知系统**：操作成功/失败浮动提示，自动消失

**⑥ api.js 参数防错位检测（`skills/btc-market-lite/scripts/api.js`）：**
- 新增 `getOKXKlines()` 参数位置错位检测：
  - `symbol` 不可传对象（防止 `{symbol, instType}` 传入）
  - `interval` 不可传对象
  - `limit` 必须为正整数
  - 检测 `interval` 位置误传 `instType` 值（如 `'SWAP'`/`'SPOT'`）→ 报错提示参数互换
- 防止调用时遗漏 COIN 或 interval/instType 参数互换导致的静默错误

**⑦ 交易教训库扩展：**
- 新增 9 篇复盘报告：ASTER, AZTEC, BTC, CHZ, ENJ, INJ, KMNO, NEAR, SPK
- `learnings/PENDING_TRADE_LESSONS.json` 持续积累待审核的行为模式

**⑧ 其他修复：**
- `scripts/sync-positions-temp.js` 时区偏移修复（`Date.now() + 8*3600000`）
- `tasks/set-alert.md` C2 约束模板修正（`getOKXKlines(COIN, '1m', 3, 'SWAP')` 参数顺序）
- `TOOLS.md` 新增「山寨币流程」脚本索引章节

**⑨ changelog/ 增量记录：**
- 新增 2 篇流程变更日志：`2026-05-21-山寨币流程LLM减负.md`、`2026-05-22-山寨币流程脚本化完成.md`

---

### 2026-05-21
> 🧹 v10 — Spawn 机制简化 + 交易教训库扩展 + 脚本工具集 + Dashboard + Git 清理

**变更内容：**

**① Spawn 触发机制简化（`AGENTS.md`）：**
- 移除 `[SPAWN_INSTANT_ANALYSIS]` / `[SPAWN_DAILY_REPORT]` 前缀消息机制
- BTC 日报、山寨币扫描、周期健康检测、交易复盘全部由 cron 直接创建隔离会话
- 仅山寨币扫描到目标后需要 spawn 子会话执行四阶段分析
- `AGENTS.md` 指令大幅精简，去除冗余的 spawn 模板

**② 交易教训库大规模扩展（`TRADE_LESSONS.md`）：**
- 新增 9 条从复盘和实战提炼的行为模式：
  - WCT（5/17）：低流动性山寨币追空陷阱与盈亏比纪律
  - ME（5/15）：入场逻辑否定点与止损位的分离
  - ORDI（5/18）：做空入场时机与动能状态的冲突
  - ENJ（5/21）：动能极端时的逆势入场禁令
  - BTC（5/15）：TP 目标应参考期权最大痛点作为支撑/阻力
  - 确认偏误、假突破时间窗口、左侧做空止损空间、OI下降≠反弹不可持续
- 每条教训包含触发场景、校准分析、分析时自问清单

**③ 任务文件重构：**
- `tasks/set-alert.md` 大幅精简（-2153行），移除冗余模板和示例
- `tasks/trade-review.md` 流程优化（-281/+?）
- `tasks/alt-intel-stage2/3/4.md` 分析深化（+336行）
- `tasks/daily-report-stage3/4.md` 增强盈亏比偏移和仓位管理逻辑

**④ 新增脚本工具集：**
| 脚本 | 用途 |
|------|------|
| `scripts/archive-cycle.js` | 周期归档（三步骤：实盘盈亏同步→规则归档→目录移动） |
| `scripts/archive-rules.js` | 统一规则归档，自动填充 C19 元数据 |
| `scripts/query-rules.js` | 多维度检索活跃+归档规则 |
| `scripts/add-rule-metadata.js` | 一次性规则元数据迁移工具 |
| `scripts/calc-hedge-y.js` | BTC 开仓对冲系数 y 计算 |
| `scripts/calc-alt-hedge-y.js` | 山寨币 BTC 趋势对冲 y 计算 |
| `scripts/calc-btc-correlation.js` | BTC 跟踪度 Pearson 相关系数 |
| `scripts/data-archive.sh` | 数据归档脚本 |
| `scripts/rules-archive.sh` | 规则归档脚本 |

**⑤ Dashboard 监控面板：**
- 新增 `dashboard/` Web 监控面板（Node.js + Express，端口 3100）
- 实时查看周期、仓位、警报和系统状态
- PM2 托管为 `july-dashboard` 进程，自动重启

**⑥ PM2 配置更新（`ecosystem.config.js`）：**
- 新增 `july-dashboard` 进程（autorestart，max 200M 内存）
- `btc-log-rotate` 改为独立 cron 管理

**⑦ TOOLS.md 大幅增补：**
- 新增「对冲系数 y 速查」：BTC 开仓对冲 + 山寨币 BTC 趋势对冲公式
- 新增「警报规则生命周期」：C19 元数据规范（11字段，4组写权限）
- 新增「核心脚本」：archive-rules.js, query-rules.js, add-rule-metadata.js
- 新增「归档来源枚举」：6种归档触发场景
- 新增「监控面板速查」：启动命令和端口
- 新增「GitHub SSH」推送配置

**⑧ 警报引擎增强（`skills/btc-alert/engine.js`）：**
- 引擎大规模重构（+443/-行），优化规则加载和错误处理
- 自愈系统完善

**⑨ 交易复盘系统扩展：**
- 新增 11 篇复盘报告：BREV, BTC×2, ENJ, HYPE, KAITO, ME, ORDI, PENGU, SUI, TRIA, WCT
- `learnings/PENDING_TRADE_LESSONS.json` 暂存区机制运行

**⑩ .gitignore 清理与动态文件排除：**
- 新增排除：`cycle-health/`, `memory/`, `data/`（全部）, `skills/btc-alert/rules/`, `skills/btc-alert/rules-state.json`
- 清理已追踪的动态文件：旧 data JSON（24个）、旧警报规则（55个）、旧 learnings、日志文件
- 后续动态生成的文件不再进入版本控制

---

### 2026-05-13
> 🛡️ v9 — 参数清洗防二次拼接 + 止损仓位计算器 + 盈亏比偏移 + 交易复盘 + 经验沉淀

**变更内容：**

**① api.js 参数清洗层（`skills/btc-market-lite/scripts/api.js`）：**
- 新增 `sanitizeSymbol()` — 自动剥离 `-USDT`/`-USDT-SWAP` 后缀 + 转大写，防止警报规则传完整 `instId` 导致二次拼接（如 `CRV-USDT-SWAP` → `CRV-USDT-SWAP-USDT`）
- 新增 `sanitizeInstType()` — 默认走合约 `SWAP`，自动映射 `CONTRACTS`/`FUTURES`/`PERPETUAL` → `SWAP`
- 新增 `sanitizePeriod()` — Rubik stat 端点 period 大小写自动纠正（`1d`→`1D`、`1h`→`1H`）
- 所有合约统计方法（OI/多空比/Taker 等）接入清洗层，规则侧无需手动保证参数正确性

**② 山寨币止损仓位计算器（`scripts/calc-position.js`）：**
- 山寨币阶段二新增止损/仓位自动计算流程（替代手动估算）
- 双层波动率体系：BTC 4H ATR 基线 + 山寨币 4H ATR × 乘数 X
- 乘数 X 按风险分层：1.5（低波动主流）→ 2.0（高波动脉冲）
- 止损向**更远处**偏移到最近技术结构位（禁止回缩）
- 仓位线性映射：`BTC基线%` 为满仓锚点，`25%` 为拒绝线
- 输出 JSON 含 `status`/`final_stop_price`/`position.size`

**③ 阶段三盈亏比偏移（`tasks/daily-report-stage3.md`）：**
- 从「整数位偏移」（±22）改为**百分比盈亏比偏移**
- 新公式：止盈让利 5%（`TP_SHIFT_PCT`）、止损多扛 5%（`SL_SHIFT_PCT`），上限 20%
- 所有币种统一适用，不再依赖「是否为整数价格」判断
- 默认杠杆从 3x 提升至 **10x**

**④ 山寨币阶段二分析深化（`tasks/alt-intel-stage2.md`）：**
- 新增「行情已走多远？」— 从启动点到当前价格的涨跌幅、耗时、距斐波那契位距离
- 新增「撇开叙事看价格」— 纯价格行为视角与叙事判断的交叉验证
- 新增「审视本周期已有判断」— 空仓视角重审，打破连续报告确认偏误
- 新增「审视触发警报」— 回溯设置警报时的市场环境，判断触发是否验证原逻辑
- 新增「驱动力衰减的事件维度」— 可预期事件（产品上线/协议升级）的「买预期卖事实」风险评估
- 止损/仓位改为脚本计算，不再手动估算

**⑤ 警报规则生命周期改为「触发即归档」默认模式（`tasks/set-alert.md`）：**
- `lifetime()` 默认模式：触发后返回 `'completed'`，引擎自动归档规则文件到 `rules-archive/`
- 备选模式：持久监控（N 天窗口，冷却后继续触发）
- 移除 `CONFIG` 全局配置引用和 `model` 参数（模型已由 agent 默认模型决定）
- 移除冗余的 `opencrl agent` notify 示例

**⑥ 警报引擎修复（`skills/btc-alert/engine.js`）：**
- `handleRuleSuccess` 仅在完整链路（check → collect → trigger）成功时调用，`check()` 返回 false 不再归零错误计数
- 规则加载失败时接入自愈管道（累计 5 次后自动派发诊断任务）
- `notifyShisiyue()` 从 `opencrl agent` 改为 `opencrl cron add`（一次性 cron job，更可靠）

**⑦ 经验行为模式沉淀：**
- 新增 `TRADE_LESSONS.md` — 从复盘和实战提炼的行为模式（脉冲行情认知偏差、风险认知与策略执行断层、确认偏误、左侧做空止损空间等）
- 新增 `learnings/` 目录 — 复盘纪要（review-20260512、review-20260513）
- `.learnings/` 迁移至根目录 `learnings/`
- `AGENTS.md` 新增「分析前必读」指引，每次分析前读取 `LEARNINGS.md`

**⑧ 交易复盘系统：**
- 新增 `tasks/trade-review.md` — 交易后复盘流程
- 新增 `tasks/cycle-health-check.md` — 活跃周期健康巡检
- 新增 `cycle-health/` 巡检报告（2026-05-10、05-12、05-13）

**⑨ PM2 日志轮转：**
- `ecosystem.config.js` 新增 `btc-log-rotate` 进程（每日 00:10 执行 `scripts/log-rotate.sh`）
- `package.json` 新增 `sharp` 依赖（K 线图表生成）

**⑩ TOOLS.md 增补（5 项经验教训）：**
- symbol vs instId 参数二次拼接陷阱
- 止盈止损判断陷阱（支撑跌破 ≠ 止盈触发）
- 警报规则延迟确认机制（instant/touch/hold/deep_hold 四档）
- 回穿检测阈值需按币种波动率缩放（山寨币不能用 BTC 的 0.1%）
- `handleRuleSuccess` 自愈路径陷阱（check=false 不能归零错误计数）

**⑪ 警报规则大规模更新：**
- 归档 34 个过期规则（AZTEC/DYDX/FIL/GALA/JTO/JUP/LIGHT/NOT/ONDO/OP/RLS/ROBO/SAHARA/SPACE/SPK/STRK/TIA/WLFI + BTC 布林带/仓位管理v2）
- 新增活跃规则覆盖 30+ 币种（ATOM/BOME/EIGEN/ENS/GMT/HUMA/JUP/KAITO/KMNO/LAYER/LDO/MON/MOVE/ONDO/ORDI/PENDLE/PENGU/POPCAT/SEI/SPK/SSV/STRK/UMA/USELESS/W/WCT + BTC 布林挤压/做空位监控）

**⑫ API_REQUESTS.md 更新：**
- Taker 买卖比新增 `period` 参数支持小时粒度（`5m`/`1H`/`1D`/`1W`/`1M`）
- 日期格式自适应：日级及以上用 `YYYY-MM-DD`，小时/分钟级用完整 ISO

### 2026-05-09
> 🏗️ v8 — 警报引擎异步化 + 自愈系统 + 山寨币策略升级

**变更内容：**

**① 警报引擎异步化重构**（`skills/btc-alert/engine.js`）：
- `api.js` 的 `fetch()` 从 `execSync(curl)` 改为异步 `http.request`，消除事件循环阻塞
- 警报规则中禁止使用 `execSync` / 同步 curl（新增 §3.2.1 规范）
- 新增日志级别控制（`LOG_LEVEL` 环境变量，默认 INFO）
- PM2 配置新增 `--max-old-space-size=256`（默认堆仅 8.85MB/93% 使用率）

**② 警报器自愈系统**：
- 引擎新增 `spawnSelfHeal()` — 规则连续报错时自动派发诊断任务给七月
- 每个规则仅一次自愈机会，10 分钟宽限期
- 新增 `tasks/alert-self-heal.md` 自愈诊断流程
- `global-config.json` 新增 `selfHeal.model` 配置

**③ 山寨币策略升级**（`tasks/alt-intel-stage2.md`）：
- 分析视野从纯右侧顺势扩展为「顺势视野 + 终局视野」双重视角
- 新增趋势阶段判断、驱动力衰减评估、反转信号评估
- 仓位从 40u 降至 30u 名义价值
- 左侧逆势操作必须使用窄止损（不允许 25% 宽止损）
- 止盈允许只设定一档

**④ 山寨币扫描器增强**（`tasks/alt-scanner.md`）：
- 活跃周期上限从 5 提升至 20
- 候选池从 Top 20 扩大至 Top 40
- 筛A+筛B 逻辑预写为 `scripts/alt-scanner-screening.py`（禁止重写，防 glob 展开bug）
- 新增上线时间检查（<30天新币自动拉黑，`config/altcoin-blacklist.json`）

**⑤ 模型配置简化**（`AGENTS.md`）：
- `sessions_spawn` 的 `model` 参数被平台静默忽略，改为直接硬编码模型名
- 所有 spawn 指令不再从 `global-config.json` 动态读取，改为静态写明
- `global-config.json` 新增 `_refs` 引用追踪（📝静态需手动同步 / 🔧运行时自动跟随）

**⑥ 警报规则全面更新**：
- 归档 22 个旧规则（AR/BILL/DASH/ICP/JTO/NEAR/TON/USELESS/WIF/ZEC）
- 新增 34 个规则（AZTEC/DYDX/FIL/GALA/JTO/JUP/LIGHT/NOT/ONDO/OP/RLS/ROBO/SAHARA/SPACE/SPK/STRK/TIA/WLFI + BTC 布林带/仓位管理v2）
- `set-alert.md` 新增：禁止 execSync、必须使用 SWAP 合约数据、lifetime 从当天有效改为 3 天窗口
- 阶段四新增 API 诉求检查点（`API_REQUESTS.md` 追踪机制）

**⑦ 数据源与工具更新**：
- `api.js` 合约统计方法增加 `symbol` 参数，新增 `getOKXFundingRate(symbol)`
- `getOKXKlines()` 内置小写→大写自动映射
- Web Search 主力引擎从 DuckDuckGo 切换为 MiniMax（DDG 触发 bot-detection）
- `btc-market-lite/SKILL.md` 数据源描述修正（实际主力为 OKX，CryptoCompare 仅用于 getGlobalVolume）
- 新增 `scripts/log-rotate.sh` 日志轮转脚本

### 2026-05-07
> 🏗️ 山寨币分析链路上线 + 模型配置全局化

**变更内容：**

**① 山寨币分析链路**：两条触发路径（Scanner 定时扫描 + 警报即时分析），四阶段流程（三维情报 → 交叉验证 → 仓位管理 → 警报管理），每币种独立周期目录 `active/alt-{COIN}-{时间}/`。

**② 全局模型配置**：新增 `tasks/global-config.json`，所有 spawn / cron / 警报规则的模型参数统一从此文件读取。BTC → `deepseek-v4-pro`，山寨币 → `deepseek-v4-flash`。

**③ AGENTS.md 双分支重构**：拆分为 BTC / 山寨币两条 Spawn 链，所有 spawn 指令的 `model` 参数改为引用 config 路径。

**④ set-alert.md 模板升级**：新增 `CONFIG` require 和 `COIN` 变量，新规则自动根据币种选择模型。21 个活跃警报规则全部改用 config 引用（0 硬编码残留）。

**⑤ 旧系统清理**：移除 `alerts/` 旧预警系统（被 `skills/btc-alert/` 取代）、`rules/archive/` 129 个过期 BTC 规则、`.bak` 备份文件、实验脚本、运行时状态文件。

**⑥ .gitignore 更新**：覆盖 `active/alt-*/`、`archived/alt-*/` 山寨币周期目录，新增运行时状态排除。

### 2026-05-03
> 🌐 多币种支持 — 数据脚本 v6

**变更内容：**

**① `--coin` 参数**：两个数据脚本新增 `--coin` 参数，支持任意 OKX USDT 合约币种，默认 BTC 向后完全兼容。

**② 动态自适应**：价格精度 6 层阶梯（≥$10k 2位 → ≥$0.000001 11位）；清算分档 8 层阶梯（$500 → $0.000001）；资金费率周期从历史时间戳自动推算（LAB=4h, SOL/BTC=8h）；修复 `parseInt` 截断小数分档键的 bug。

**③ 健壮性增强**：Spot→Swap 双重回退（指标+斐波那契）；Deribit 期权仅 BTC/ETH（其他币种自动跳过）；保存文件非BTC自动加币种后缀（`2026-05-03_LAB.json`）。

### 2026-04-26
> 📊 多价位警报监控 + 数据脚本优化 + SOUL.md人格定义

**变更内容：**

**① 警报系统多价位监控改造**
- 单规则支持多价位监控（≤6价位打包），避免筛选丢弃有意义价格
- 使用K线区间数据而非瞬时价格，捕捉瞬时突破
- 组合触发：单次传递所有被触发的价位信息
- 废弃上方/下方各1个限制，改为 ≤6 价位自由组合

**② 数据获取脚本简化**
- 日报脚本：资金费率独立成 fundingRateList，API调用从7次减为4次
- 即时脚本：15m级别砍掉多空比/大户比/Taker（噪音过大），API调用从9次减为6次
- Taker只保留ratio，去掉buyVol/sellVol单独存储
- 多空比/大户比/Taker 砍掉1H调用，只用1D（当天数据为实时累计值）

**③ 新增数据源**
- Premium Index（当前溢价指数）
- Basis 历史（14天基差历史）
- 清算数据（24小时多空清算统计、最近5条清算记录详情）

**④ 数据结构压缩**
- fundingRateList → fundingRate.values 数值数组格式
- basisHistory → basis.values 数值数组格式
- 添加 period、count、spanDays 元数据字段
- 添加概念说明字段（premiumNote、fundingRate.note、basis.note）
- 数据大小减少28.9%（26KB → 18.5KB）

**⑤ SOUL.md 人格定义完善**
- 新增完整人格定义文档（冷静理性的比特币分析师）
- 核心人格：数据信仰、信号/噪音区分、概率思维、简洁有力
- 说话风格：专业术语日常化、不讨好不客套、坦诚面对不确定性
- 分析本能：多维度看市场、关键位置敏感度

**⑥ 日期获取修复**
- tasks/set-alert.md 修复 lifetime() 方法日期获取问题
- 使用 `api.getLocalDate()` 替代 `new Date().toISOString()`
- 解决UTC+8时区下日期偏差一天的问题

**⑦ 警报规则更新**
- 归档 4/23 旧规则：multi-price、oi-drop
- 新增 4/26 活跃规则：multi-price（多价位监控）、oi-recovery、taker-ratio

---

### 2026-04-23
> 🔧 警报引擎日志规范化 + check()日志输出规范

**变更内容：**

**① engine.js — 警报引擎日志统一化**
- 移除独立 `alert-engine.log` 文件写入，改为统一输出到控制台（由 PM2 捕获到单一日志文件）
- 日志前缀统一为中文 emoji 格式：`[🔧警报引擎]` / `[❌警报引擎错误]` / `[🔍警报检查]`
- 规则方法（check/collect/trigger）执行时使用 `.call(rule)` 保持 `this` 绑定
- 移除 `ENGINE_LOG` 常量和 `fs.appendFileSync` 写入逻辑

**② ecosystem.config.js — 日志合并**
- `error_file` 和 `out_file` 统一指向 `./logs/btc-alert.log`
- 错误和输出合并为同一文件，避免分散查看

**③ tasks/set-alert.md — check() 日志输出规范（新增 3.1 节）**
- 每次心跳检查必须输出三部分信息：
  - `[API]` 数据来源说明（如 OKX/CryptoCompare 获取了什么数据）
  - `[进度]` 触发进度可视化（当前值、阈值、触发状态）
  - `[来源]` 警报设立依据（来源于哪份报告的什么观点）
- 新增延迟触发警报的特殊日志格式
- 原价格警报数量限制从 3.1 改为 3.2

**④ 警报规则归档与更新**
- 归档 4/21 旧规则：resistance-76500, support-75000, volatility-squeeze, volume-surge
- 归档 4/22 规则（约20个）：funding-rate, longshort-ratio, oi-recovery, 多个 resistance/support 等
- 归档 4/22 创建的 4/23 规则：longshort-rebound, oi-drop, resistance-80000, support-78963
- 新增 4/23 活跃规则：oi-drop, resistance-79443, support-77500

**⑤ positions.json 更新**
- 逐仓持仓备注更新：API 返回的多头/空头记录持仓量均为 0，已全部平仓

---

### 2026-04-22
> 📝 日志规范化 + 逐仓参数强制化 + 新周期开启

**变更内容：**

**① tasks/daily-report-stage3.md — 操作日志强制规范**
- 新增「日志强制要求」表格：开仓/加仓/减仓/平仓/调整/设置止盈止损/跳过执行 全部要求记录
- 明确每种操作的日志格式原则（操作类型 + 结果 + 关键参数）
- 所有 OKX 持仓查询命令强制添加 `--tdMode isolated`（逐仓）
- 新增多处执行日志格式规范（加仓成功、减仓成功、止盈止损更新等）

**② tasks/sync-positions.md — 逐仓参数统一**
- 所有 OKX API 命令强制添加 `--tdMode isolated` 参数
- 涵盖：positions、orders、algo orders、bills、positions-history

**③ active/ — 周期归档与新建**
- 归档 cycle-20260420-001（已结束）
- 新建 cycle-20260421-001（当前活跃周期，当前无持仓）

**④ rules/ — 警报规则归档**
- 归档 8 个过期规则到 rules-archive/：
  - oi-decline-10pct、lsr-taker-divergence、oi-break-3350m、oi-break-3450m
  - resistance-76500-delayed、resistance-77000-delayed
  - support-75550、support-76500

---

### 2026-04-21
> 🔧 修复阶段三最小仓位判断逻辑错误 + 新增即时分析阶段一任务

**新增任务：`tasks/instant-analysis-stage1.md`**
- 专门用于被即时分析触发的阶段一任务

- 职责：解析警报数据、补全市场数据、同步实盘持仓
- 输出：数据清单路径，传递给后续阶段

**问题修复：** 阶段三在判断 BTC-USDT-SWAP 最小下单量时，误将 `minSz = 0.01` 当作 `1` 处理，导致计算出的开仓张数（如 0.28 张）被错误拒绝。

**修复内容：**
- 正确理解 OKX 合约参数：`minSz = 0.01张`，`lotSz = 0.01张`，`ctVal = 0.01 BTC`
- 更新判断逻辑：`sz < 0.01` 才拒绝下单，而非 `sz < 1`

**执行记录：**
- 开仓：做空 BTC-USDT-SWAP 0.28 张，成交价 $75,713.4
- 止损：$76,550
- 止盈1：$74,478（平仓 50%）
- 止盈2：$73,812（平仓剩余 50%）

---

### 2026-04-19（v4.18-v4.19）
> ⚠️ 本次更新为重大架构升级，变更涉及多个核心模块，建议仔细阅读。

---

#### 🌟 一、四阶段日报流程（最大变更）

**旧架构：** 单一日报任务 `daily-report.md`，包含数据获取、分析、警报管理全流程。

**新架构：** 四阶段流水线，每个阶段独立子会话，职责单一：

| 阶段 | 任务文件 | 职责 | Spawn 传递 |
|------|---------|------|-----------|
| 阶段一 | `daily-report-stage1.md` | 数据获取（持仓同步、市场数据、数据挖掘、生成清单） | 数据清单路径 |
| 阶段二 | `daily-report-stage2.md` | 数据分析（读清单 + 历史报告 + 持仓 → 生成分析报告） | 周期目录 |
| 阶段三 | `daily-report-stage3.md` | 仓位管理（读报告 → 识别意图 → 执行交易 → 同步持仓 → 判断归档） | 周期状态 + 路径 |
| 阶段四 | `daily-report-stage4.md` | 警报管理（归档失效规则 → 候选 → 筛选 → 创建新规则） | 周期状态 + 路径 |

**为什么这样改？**
- 阶段越多，上下文窗口越干净（每阶段只读必要文件）
- 职责单一，每阶段失败都能精准定位
- 子会话 Spawn 链：主会话 → 阶段一 → 阶段二 → 阶段三 → 阶段四

**日报进程日志：** 所有阶段共用 `logs/daily-report-process.log`，统一日志格式：
```
正常: [时间] [阶段X] 内容
警告: [时间] [阶段X] ⚠️ WARN: 内容
错误: [时间] [阶段X] ⛔ ERROR: 内容
```

**日志分级原则：**
- `⚠️ WARN`：不影响流程继续执行（数据部分缺失、历史报告不足）
- `⛔ ERROR`：可能影响后续阶段，需人工介入（脚本失败、文件创建失败）

---

#### 🌟 二、子会话 Spawn 限制说明

OpenClaw 安全机制：**子会话无法直接 spawn 另一个子会话**（防止 Spawn 链无限嵌套）。

**日报流程中的处理：**
- 阶段X完成 → 返回消息给主会话（包含下一阶段任务指令）
- 主会话收到 → 执行 spawn 启动阶段Y
- 各阶段在返回消息中标注下一阶段任务文件路径

**Spawn 消息规范（最终版）：**
```
阶段一数据获取已完成。
数据清单: active/cycle-xxx/data-context/data-manifest-xxx.json
请读取 tasks/daily-report-stage2.md 开始阶段二分析。
```

**保底机制：** 每个阶段都有 spawn 消息解析 + 本地路径查找双保险，任意一个成功即可继续。

---

#### 🌟 三、持仓同步系统重构

**新增 `tasks/sync-positions.md`** — 从 OKX 实盘获取 BTC 逐仓持仓数据，生成 `positions.json`。

**核心设计：**
- **中文字段名**：便于阅读（`持仓ID`、`平均入场价`、`未实现盈亏` 等）
- **每次覆写**：OKX API 数据是权威来源，直接从 API 获取并覆写
- **只记录当前持仓**：无需历史持仓列表

**新增 `positions.json` 结构：**
```json
{
  "周期ID": "cycle-20260419-001",
  "同步时间": "2026-04-19T09:00:00+08:00",
  "当前持仓": [
    {
      "持仓ID": "3429443563167604736",
      "合约": "BTC-USDT-SWAP",
      "持仓方向": "long",
      "平均入场价": "74767.8",
      "未实现盈亏": "0.21",
      "委托订单": [ /* 止盈止损订单 */ ],
      "操作记录": [ /* 开仓、资金费、止盈触发等 */ ]
    }
  ],
  "最近平仓": null,  // 或平仓信息对象
  "汇总": { "当前持仓数": 1, "未实现盈亏总计": 0.21 }
}
```

**平仓检测：** 对比旧持仓文件，判断"从未开仓（null）"还是"曾开仓已平仓（填充平仓信息）"

**同步数据源：** OKX API — 持仓、止盈止损订单（limit + conditional）、账单记录

---

#### 🌟 四、新增 `execute-trade.md` — 仓位执行任务（已合并入阶段三）

独立的仓位执行模块现已合并入 `tasks/daily-report-stage3.md` 和 `tasks/alt-intel-stage3.md`，不再单独维护。

---

#### 🌟 五、数据脚本升级

**`api.js` 新增三个 OKX API（需代理）：**
- `getOKXOpenInterest()` — 持仓量（OI）数据
- `getOKXTakerRatio()` — Taker 买卖比
- `getOKXLongShortRatio()` — 多空比

**`get_enhanced_analysis.js` 优化：**

1. **交易量字段修正**：`vol24h × last` → `volCcy24h × last`（后者才是 BTC 单位交易量）
2. **交易量统一为 USDT 单位**：K线 volume 改用 `volCcyQuote`（k[7]），不再保留 BTC 单位
3. **新增格式化函数**：`formatVol()` 自动添加 `$1.23M` / `$456K` 等易读后缀
4. **斐波那契数据压缩**：从嵌套对象改为扁平数组 `levels[]`（0%/23.6%/38.2%/50%/61.8%/78.6%/100%）
5. **期权数据压缩**：统一用 `oi`/`vol` 对象替代多个独立字段，`resistance`/`support` 改为 `[strike, netOI]` 数组

---

#### 🌟 六、目录结构变化

**`active/cycle-*/` 结构更新：**
```
active/cycle-YYYYMMDD-XXX/
├── positions.json          # 🆕 实盘持仓文件（替代 trade-suggestions.json）
├── trade-suggestions.json  # ❌ 交易建议文件（已移除）
├── data-context/           # 阶段一产出
│   ├── data-manifest-*.json
│   └── data-mining-*.md
└── reports/
    ├── btc-report-*.md
    └── instant-report-*.md
```

**🆕 新增目录：**
- `scripts/sync_positions.js` — 持仓同步脚本（简化版）
- `scripts/sync_positions_full.js` — 持仓同步脚本（完整版，含止盈止损）
- `archived/cycle-20260416-001/` — 已归档周期
- `archived/cycle-20260417-001/` — 已归档周期
- `active/cycle-20260419-001/` — 新活跃周期

**❌ 已删除：**
- `tasks/daily-report.md`（拆分为 4 个阶段文件）
- `tasks/daily-report-stages-overview.md`（已完成使命）
- `tasks/alert-debug.md`（警报调试任务移除）

---

#### 🌟 七、警报规则归档

本次更新归档了以下过期规则：
- `2026-04-14-ls-reverse.js` — 多空比反转警报
- `2026-04-14-oi-change.js` — OI 变化警报
- `2026-04-15-resistance-75000.js` — $75,000 阻力警报
- `2026-04-15-support-73500.js` — $73,500 支撑警报

同时归档了多个历史规则（`rules-archive/`）。

---

#### 🌟 八、阶段三仓位管理流程详解

阶段三是本次架构升级最复杂的模块，完整流程：

```
1. 读取 positions.json 了解实盘持仓
2. 阅读整篇日报，提炼操作意图（开仓/加仓/减仓/平仓/调整止盈止损/观望）
3. 验证操作合理性（方向冲突？无仓位却减仓？）
4. 判断执行时机（立即入场 vs 等待触发）
5. 执行仓位操作（调用 OKX API）
   - 开仓：余额检查 → 计算张数 → 市价下单 → 等待成交 → 设置止盈止损
   - 加仓：同开仓，但需重建覆盖全部仓位的止盈止损
   - 减仓：部分平仓 + 重建剩余仓位止盈止损
   - 平仓：取消止盈止损 → 市价全平
   - 调整止盈止损：取消旧订单 → 设置新订单
6. 同步持仓文件（调用 sync-positions）
7. 判断归档（持仓数=0 且 最近平仓非空 → 归档）
8. Spawn 阶段四（传递周期状态和路径）
```

---

#### 🌟 九、阶段四警报管理 — 两步筛选法

**步骤1（发散）：** 从日报全文罗列所有警报候选（不限于价格，包含交易量/波动率/OI/多空比等）

**步骤2（收敛）：** 按数量限制筛选最终活跃规则：

| 类型 | 限制 |
|------|------|
| 上方价格警报 | ≤1 个（最接近当前价的阻力位/入场触发价） |
| 下方价格警报 | ≤1 个（最接近当前价的支撑位/入场触发价） |
| 非价格警报 | ≤2 个 |
| **总计** | **3~4 个** |

**归档条件（灵活判断）：**
- 价格位已失效（支撑/阻力已突破）
- 报告趋势判断与警报方向冲突
- 入场条件已执行

**禁止 FGI 触发**（恐惧贪婪指数更新周期为日，不适合分钟级警报）

## 更新日志

---

### 2026-04-14
- **警报系统核心升级** 🔔
  - 新增三大核心原则（价格警报数量限制、禁止FGI作为触发条件、创造性警报设计）
  - 价格警报最多保留2个（向上/向下各1个），防止冗余
  - 禁止使用恐惧贪婪指数作为警报触发条件（更新频率低，不适合高频监控）
  - 新增多种创造性警报类型：资金费率、持仓量变化、多空比反转、Taker买卖比等
  - 更新 `tasks/set-alert.md` 和 `tasks/alert-management.md` 警报设计指南
- **警报触发机制澄清** ⚠️
  - 明确：警报触发 ≠ 自动入场
  - 警报是"入场条件监控器"，触发后需即时分析确认是否满足入场条件
  - 更新日报和即时分析任务中的相关说明
- **数据脚本优化** 📊
  - `get_enhanced_analysis.js` 同时获取 1D 和 1H 周期数据
  - 最新一天使用 1H 数据更精确（历史天数用 1D）
  - 修复 API 周期匹配问题（多空比、Taker买卖比 API 不支持 4H，改用 1H 匹配）
- **报告分发架构调整** 📝
  - 七月不再自动发送飞书，改为保存本地文件
  - 十四月负责从 `active/cycle-*/reports/` 读取并转发
  - 移除 `IDENTITY.md`、`USER.md`、`TOOLS.md` 中的飞书配置
  - 移除任务文件中的发送步骤（daily-report、instant-analysis、alert-debug）
- **新增警报规则** 🎯
  - `2026-04-14-funding-rate.js` - 资金费率警报（已归档）
  - `2026-04-14-oi-change.js` - 持仓量变化警报
  - `2026-04-14-stoploss-72000.js` - 止损位监控（从 $70,500 上移至 $72,000）
  - `2026-04-14-takeprofit-75000.js` - 止盈位监控
- **新交易周期** 🔄
  - 开启 cycle-20260413-001，持仓 $72,000 入场做多
  - 止盈1($73,500)已触发，建议平仓50%

### 2026-04-13
- **API 数据源选择规则** 🌐
  - 新增 TOOLS.md 数据源选择规则：不要猜测 endpoint，先查看现有代码
  - 记录多空比 API 选择错误教训：错误使用 Binance API 导致地区限制
  - 正确 endpoint 参考：OKX `long-short-account-ratio`、`open-interest-volume` 等
  - 国内网络禁止使用 Binance API，必须使用 OKX 替代
- **警报器代理支持** 🔔
  - 警报规则获取数据时需通过代理访问 OKX API
  - 添加代理配置示例到 TOOLS.md

### 2026-04-10
- **实盘交易整合** 💰
  - 七月接入 OKX 实盘交易 CLI（`okx` 命令）
  - 新增 TOOLS.md OKX 交易 API 使用说明
  - 代理 wrapper 脚本：`scripts/okx-proxy.sh`（国内网络必须使用）
  - Profile 模式：`live`（实盘）/ `demo`（模拟盘）
- **仓位执行检查流程** 📋
  - 日报/即时分析任务新增"仓位执行检查"步骤
  - 根据 `trade-suggestions.json` 状态自动执行开仓/止盈/止损
  - 安全限制：杠杆固定 3x，逐仓模式，止盈止损覆盖全部仓位
- **整数位偏移规则** ⚡
  - 止盈设置避开整数价位（如 72000 → 72478）
  - 提高触发概率，防止差一点不到
  - 止损不偏移（保护机制无需刻意避开整数位）
- **版本号升级** 🔢
  - 报告版本升级到 `七月-v4.12`

### 2026-04-09
- **安全改进：飞书凭证配置化** 🔐
  - 新增 `.openclaw/credentials.json` 存放飞书 App ID 和 targetOpenId
  - 更新 `.gitignore` 排除敏感配置文件
  - 所有文档改为指向配置文件读取，移除硬编码凭证
- **数据脚本升级 v5** 📊
  - `get_enhanced_analysis.js` / `get_instant_data.js` 升级到 v5
  - 数据源从 Binance 改为 OKX CLI（统一数据源，服务端计算技术指标）
  - 新增 `scripts/okx-proxy.sh` 代理 wrapper（使用 proxychains4）
- **自触发 SPAWN 机制** ⚡
  - 新增 `[SPAWN_DAILY_REPORT]` 前缀触发日报任务
  - AGENTS.md / tasks/daily-report.md 新增自触发说明
  - 主会话保持清爽，子会话独立执行任务
- **警报规则更新** 🔔
  - 归档过期规则（$69500阻力、$68000支撑等）
  - 新增活跃规则：$75000阻力突破、$70000支撑跌破、多空比下跌警报
- **数据源架构升级** 🌐
  - 新增 OKX 数据源作为主力（无地区限制，无需特殊网络配置）
  - Binance 作为备用，自动切换（需代理）
  - 解决国内环境数据获取不稳定问题
- **斐波那契分析模块** 📐
  - 新增多时间框架斐波那契回调分析：日线 / 4小时 / 周线
  - 自动识别波段高低点并计算关键价位 (23.6% / 38.2% / 50% / 61.8% / 78.6%)
  - 报告输出新增斐波那契表格，直观展示各级别支撑阻力
  - 新增 Python 版分析脚本 `scripts/multi_timeframe_fib.py`
- **期权数据格式优化** 🔮
  - 输出字段重命名，更易理解（如 `putCallRatioOI` 替代 `pcOI`）
  - 新增字段说明注释，方便后续智能体理解数据含义
- **PM2 配置更新** ⚙️
  - 工作目录路径修正到当前环境
  - 新增代理环境变量配置 (`http_proxy`, `https_proxy`, `all_proxy`)
- **依赖管理** 📦
  - 新增 `package.json` 和 `package-lock.json`
  - 添加 `https-proxy-agent` 依赖

### 2026-04-07 (v2)
- **期权数据整合** 🔮
  - 新增 Deribit 期权数据获取（两大核心到期日）
  - 新增指标：Put/Call Ratio、Max Pain、隐含波动率、关键支撑阻力
  - 移除动量指标（滞后性，非领先数据）
- **数据源**：Binance Futures + alternative.me + Deribit

### 2026-04-07 (v1)
- **交易建议状态系统重构** 🔄
  - 新增 `pending_entry` 状态，区分"等待入场"和"持仓中"
  - 状态流转：`pending_entry` → `open` → `closed`
  - 入场确认由即时分析任务执行
- **入场条件机制** ⭐
  - 每个建议必须有 `entry_condition` 字段
  - 类型：`immediate`（立即入场）/ `delayed`（延迟入场）/ `conditional`（条件触发）
  - 非立即入场必须创建对应警报监控触发条件
- **警报类型扩展** 🔔
  - 新增 **定时器警报**：纯时间触发，不依赖市场数据（如"N小时后检查入场"）
  - 新增 **延迟触发警报**：价格条件满足后等待确认（如"突破后等待30分钟验证有效性"）
  - 更新 `tasks/set-alert.md` 添加完整示例代码
- **即时分析任务增强** 📊
  - 新增 `pending_entry` 入场确认流程
  - 支持即时分析创建新交易建议（周期内无建议或市场新机会时）
- **任务规则更新** 📝
  - `tasks/daily-report.md` - 交易建议状态管理 + 入场条件机制
  - `tasks/instant-analysis.md` - 入场确认 + 新建议创建流程
  - `tasks/set-alert.md` - 定时器/延迟触发警报示例

### 2026-03-31
- **警报器引擎优化** ⏱️
  - 新增触发冷却机制：同一规则触发后30分钟内不再重复触发
  - 支持规则自定义冷却时间 `cooldownMs`
  - 防止价格在关键位徘徊时频繁触发警报
- **即时分析数据脚本** 📊
  - 新增 `skills/btc-market-lite/scripts/get_instant_data.js`
  - 获取短周期K线数据：12根4h、4根1h、8根15m
  - 附带交易侧数据：资金费率、OI、多空比、Taker买卖比
  - 支持代理参数 `--proxy`
- **代理使用备忘** 🌐
  - 新增 `memory/proxy-usage.md` 统一记录代理配置
  - 敏感凭证移至 `~/.openclaw/credentials/` 管理
  - 删除旧的 `mihomo-proxy.md` 和测试脚本
- **周期归档** 📦
  - `cycle-20260327-001` 和 `cycle-20260330-001` 已归档
  - 新增当前周期 `cycle-20260331-001`
- **规则整理** 🔧
  - 大量过期规则归档到 `rules/archive/`
  - 当前活跃规则：支撑位 $65,750、阻力位 $69,200

### 2026-03-27
- **数据源扩展** 📊
  - 新增 Binance Futures 数据源（资金费率、持仓量、多空情绪、Taker买卖比）
  - 支持 4 小时级别 K 线数据（14根）
  - 新增 `data/SCHEMA.md` 数据字段说明文档
  - 更新 `btc-market-lite` 技能支持多数据源整合
- **代理支持** 🌐
  - 新增 Mihomo 代理配置备忘 (`memory/mihomo-proxy.md`)
  - 数据获取脚本支持 `--proxy` 参数
  - Binance API 通过代理可正常访问
- **测试工具** 🧪
  - 新增 `scripts/` 目录存放测试脚本
  - Binance API 连接测试脚本
- **周期归档** 📦
  - 交易周期 `cycle-20260323-001` 已归档
  - 警报规则 `2026-03-25-resistance-73000` 和 `2026-03-26-support-67000` 已归档
  - 新增当前警报规则：阻力位 $69,500、支撑位 $67,500
- **任务提示词优化** 📝
  - 新周期禁止读取归档文件夹，避免历史干扰
  - 新增趋势联动分析引导，强调历史走势与指标间关系
  - 新增补充数据评估步骤，列出可用 API 方法
  - 报告末尾新增"警报变更"和"补充数据"两部分
  - 更新 `tasks/daily-report.md` 和 `tasks/instant-analysis.md`

### 2026-03-19
- **交易周期系统上线** 🔄
  - 新增 `active/` 和 `archived/` 目录结构
  - 交易建议独立管理，支持周期隔离
  - 报告路径改为 `active/cycle-*/reports/`
  - 新增 `july-report-monitor` PM2 进程监控报告并通知十四月
  - 更新 `daily-report.md` 和 `instant-analysis.md` 任务规则
  - 七月不再读取历史周期数据，每轮交易独立运行

### 2026-03-09
- **报告发送方式优化** 📄
  - 优先使用飞书文档发送完整日报（无长度限制、格式美观、可编辑）
  - 备选方案：分段消息发送（飞书单条消息限制约 4KB）
  - 更新 TOOLS.md 添加发送方式说明

### 2026-03-06
- **引擎时区修复** 🕐
  - 警报器引擎日志时间戳改为北京时间 (GMT+8)
  - 解决日志时间与实际时间相差8小时的问题
- **即时分析任务优化**
  - 明确要求发送保存的报告 md 文件到飞书
- **警报规则更新**
  - 新增阻力位突破警报 ($72,000)
  - 新增心理支撑跌破警报 ($70,000)
  - 新增关键支撑跌破警报 (7日EMA $69,678)
  - 归档 3 月 5 日的过期规则

### 2026-03-05
- **即时分析任务** 🎯
  - 新增 `tasks/instant-analysis.md` 任务规则
  - 警报触发时自动调用，进行针对性分析
  - 回顾24小时内所有报告（日报+即时分析）
  - 独立日志文件 `logs/instant-reports.log`
- **警报器管理任务** 🛠️
  - 新增 `tasks/alert-management.md` 任务规则
  - 日报/即时分析完成后自动调用
  - 查看当前规则、归档过期规则、创建新规则
  - 所有新规则默认触发即时分析任务
  - 独立日志文件 `logs/alert-management.log`
- **任务流程优化**
  - 日报和即时分析任务末尾新增警报器管理触发
  - 形成完整闭环：分析 → 管理警报 → 监控 → 触发分析
- **警报器热更新支持**
  - 新增文件扫描定时器（每分钟检查规则文件是否存在）
  - 手动归档规则文件后，引擎自动感知并卸载该规则
  - 无需重启引擎即可移除运行中的规则

### 2026-03-04
- **警报器系统上线** 🎉
  - 灵活的规则接口：check/collect/trigger/lifetime
  - 智能体可动态编写警报规则
  - 自动归档过期规则
  - 完整的日志系统
- 新增 `api.js` 模块，提供可复用的市场数据 API
- 新增任务路由：设定市场警报、警报调试报告
- 警报报告自动保存到 `active/cycle-*/reports/` 并发送飞书
- 数据源迁移到 CryptoCompare API
- 新增 get24hVolume() 函数，聚合24小时交易量
- 修复 volumeRatio 计算失真问题

### 2026-03-03
- **架构重构**：AGENTS.md 改为路由模式，任务规则独立到 `tasks/` 目录
- 绑定独立飞书机器人账户 (`july`)
- 配置 DM 白名单策略
- 新增历史日报关联能力（回顾 3 天内报告）
- 脚本新增 `--save` 参数，自动保存数据
- **日报存储改造**：
  - 新建 `reports/` 文件夹专门存放日报（已废弃，改用周期系统）
  - 日报命名格式改为 `btc-report-YYYY-MM-DD-HHMM.md`

### 2026-03-02
- 更新 AGENTS.md 工作流程
- 优化报告格式和存储

### 2026-02-27
- 创建七月智能体
- 集成 btc-market-lite 技能
- 配置定时任务 (9:00/21:00)
- 实现飞书报告推送

---

*创建于 2026-02-27 · 由 OpenClaw 驱动*