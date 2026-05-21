# TOOLS.md - 七月工具笔记

> 按出错代价排序。先看陷阱，再看数据，最后查脚本。

---

## ⚠️ 陷阱区 — 踩过的坑不要再踩

### 警报器规则 API 合约

见 `skills/btc-alert/engine.js` `runRule()`。规则必须实现四个方法：

| 方法 | 返回类型 | 说明 |
|------|---------|------|
| `check()` | `boolean` | 触发条件满足？ |
| `collect()` | `object` | 收集触发数据 |
| `trigger(alert)` | `void` | 触发动作 |
| `lifetime()` | `'active'` \| `'expired'` \| `'completed'` | ⚠️ 必须返回字符串！ |

**常见错误**：`return ageHours < 72` ❌ → `return ageHours < 72 ? 'active' : 'expired'` ✅

### symbol vs instId 参数陷阱

警报规则中传 `symbol` 只传币种基础名（`CRV`），不要传完整 `instId`（`CRV-USDT-SWAP`）。
函数内部会根据 `instType` 自动拼后缀，传完整 instId 会拼出 `CRV-USDT-SWAP-USDT`。

```javascript
// ✅ 正确
getOKXKlines({ symbol: 'CRV', instType: 'SWAP', bar: '1H' })
// ❌ 错误
getOKXKlines({ symbol: 'CRV-USDT-SWAP', bar: '1H' })
```

### 止盈止损判断

| 概念 | 判断 |
|------|------|
| 止盈触发 | 最低价 ≤ 止盈价 |
| 止损触发 | 最高价 ≥ 止损价 |

归档前必须核对价格是否真正触发，不能混淆「支撑跌破」和「止盈触发」。

### 警报规则延迟确认

多价位规则必须带延迟确认，防 K 线影线假突破：

| 策略 | 延迟 | 场景 |
|------|------|------|
| instant | 0min | SL 止损位 |
| touch | 3-5min | TP 止盈位 |
| hold | 10-20min | 入场触发位 |
| deep_hold | 20-30min | 整数关口/远处观测位 |

确认期间做回穿检测：价格回穿超阈值则重置计时。

### 回穿检测阈值

`maxRetracePercent` 需按币种波动率缩放，不能统一 0.1%。

- BTC：0.1% 合理
- 山寨币（日波动 16-78%）：需要放大，否则计时器永远在重置循环

### 自愈系统（已修复，备忘）

`handleRuleSuccess()` 仅在完整链路（check→collect→trigger）成功时调用。`check()` 返回 `false` 不归零 `consecutiveErrors`。

---

## 📡 数据获取

### OKX API

**代理**：国内必须通过 `http://127.0.0.1:7890`。使用 wrapper 脚本：
```bash
~/.openclaw/july-btc-analyzer/scripts/okx-proxy.sh --profile live <command>
```

**K线 interval**：`getOKXKlines()` 已内置映射，传小写 `'1h'`/`'4h'` 可用。直接调 REST API 时注意：
- K线 `bar`: 分钟 `1m`/`15m`，小时 `1H`/`4H`，日 `1D`
- Rubik `period`: 仅 `5m`/`1H`/`1D`

**已验证端点**：
| 数据 | Endpoint |
|------|----------|
| 多空比 | `rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D` |
| Taker买卖比 | `rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D` |
| OI | `rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D` |
| 恐惧贪婪 | `api.alternative.me/fng/?limit=N` |

**速率限制**：≤ 5 req/s 安全。限流后 10s 恢复。❌ 禁止使用 Binance API（国内地区限制）。

**警报器内数据获取**：
```javascript
const PROXY_URL = 'http://127.0.0.1:7890';
execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, { encoding: 'utf8', timeout: 20000 });
```

---

## 🔧 脚本索引

| 脚本 | 用途 | 用法 |
|------|------|------|
| `scripts/okx-proxy.sh` | OKX API 代理包装器 | `--profile live \| demo <cmd>` |
| `scripts/calc-hedge-y.js` | BTC 开仓对冲系数 y | `--direction long\|short` |
| `scripts/calc-alt-hedge-y.js` | 山寨币 BTC 趋势对冲 y | `--coin ETH --direction long --btc-trend bearish` |
| `scripts/calc-btc-correlation.js` | BTC 跟踪度 Pearson | `--coins ETH,SOL,DOGE` |
| `scripts/calc-position.js` | NOMINAL_BASE → sz 计算 | 阶段三调用 |
| `scripts/archive-cycle.js` | 周期归档（三步骤：实盘盈亏同步→规则归档→目录移动） | `--cycle <id> [--by <enum>] [--reason "..."] [--close-type "..."] [--dry-run\|--force\|--no-sync\|--no-rules]` |
| `scripts/archive-rules.js` | 规则归档 | `--rule\|--coin\|--cycle --by <enum> --reason "..."` |
| `scripts/query-rules.js` | 规则查询 | `--coin\|--type\|--archived --format table\|json\|summary` |
| `scripts/agg-orderbook.sh` | 订单簿聚合 | 阶段一调用 |
| `scripts/alt-scanner-oi-filter.py` | 山寨币 OI 过滤 | 扫描流程 |
| `scripts/alt-scanner-screening.py` | 山寨币筛选 | 扫描流程 |
| `scripts/generate_kline_chart.py` | K线图生成 | 报告可视化 |
| `scripts/multi_timeframe_fib.py` | 多时间框架斐波那契 | 阶段二调用 |
| `scripts/sync_positions.js` | 仓位同步 | `tasks/sync-positions.md` |

---

## ⚙️ 基础设施速查

### OKX 交易 CLI

包装器：`scripts/okx-proxy.sh`。完整命令参考：`okx-cex-trade` / `okx-cex-market` / `okx-cex-portfolio` 三个 skill。

⚠️ 减仓用反向市价单，不能用 `swap close`（会全平）。

### OnchainOS 链上数据

CLI：`onchainos`（v2.5.0，`~/.local/bin/onchainos`）。完整参考：`okx-dex-token/SKILL.md`。

### PM2 警报器引擎

服务名 `btc-alert`，配置 `ecosystem.config.js`。
```bash
pm2 list/logs/restart btc-alert && pm2 save
```

### Web Search

主力 MiniMax（直连），备用 DuckDuckGo（需代理 `127.0.0.1:7890`）。
切换需编辑 `openclaw.json` 后 `systemctl --user restart openclaw-gateway.service`（SIGUSR1 热加载不够）。

### 监控面板（Dashboard）

Web 监控面板，实时查看周期、仓位、警报和系统状态。

```bash
# 启动（默认端口 3100）
cd dashboard && npm start
# 指定端口
node server.js --port=3200
```

访问 `http://localhost:3100`。详细 API 和功能说明见 `dashboard/README.md`。

### GitHub SSH

密钥：`~/.openclaw/workspace-july/.ssh/id_ed25519`
```bash
GIT_SSH_COMMAND="ssh -i ~/.openclaw/workspace-july/.ssh/id_ed25519" git push
```

---

## 📐 对冲系数 y 速查

### BTC 开仓对冲

```
y = 0.5 + opposing_ratio
long → opposing = 空头占比  |  short → opposing = 多头占比
y<1 缩减, y=1 均衡, y>1 放大
```
脚本：`scripts/calc-hedge-y.js --direction long|short`

### 山寨币 BTC 趋势对冲

逆势时（btc↓ ∧ alt↑ 或 btc↑ ∧ alt↓）按 BTC 跟踪度缩减：
```
y = 1.0 - 0.5 × (corr - 0.15) / (0.85 - 0.15), clamped [0.5, 1.0]
```
脚本：`scripts/calc-alt-hedge-y.js --coin <COIN> --direction long|short --btc-trend bullish|bearish|sideways`

顺势或 sideways → y=1.0。异常回退 → y≈0.75。

---

## 📋 警报规则生命周期

### 规则元数据（C19 — 11 字段）

```javascript
// ═══ C19: 规则元数据 ═══
// —— 身份 ——
ruleType: 'price-levels',     // price-levels | oi-monitor | funding-reversal | taker-ratio | ls-reversal | composite
coin: 'BTC',
cycleId: 'cycle-20260518-001', // BTC: cycle-YYMMDD-NNN | 山寨: alt-{COIN}-YYMMDD-HHMM
status: 'active',
// —— 创建 ——
createdAt: '2026-05-19T09:00:00+08:00',
createdBy: 'daily-report-stage4', // daily-report-stage4 | alt-intel-stage4 | alt-instant-stage1 | alert-self-heal | manual
sourceReport: 'active/.../reports/...md',
// —— 归档 ——
archivedAt: null,            // 归档时写入
archivedBy: null,            // stage4-cleanup | trigger-fired | cycle-archived | cycle-health-check | manual | lifetime-expired
archiveReason: null,
// —— 运行时（引擎自动更新） ——
lastCheckedAt: null,         // [引擎写入] 每次 check() 执行后更新
// ═══ C19 END ═══
```

| 组 | 字段数 | 谁写 |
|----|-------|------|
| 身份 | 4 | 创建时 |
| 创建 | 3 | 创建时 |
| 归档 | 3 | 归档时 |
| 运行时 | 1 | 引擎 check() 后 |

### 核心脚本

| 脚本 | 用途 | 用法 |
|------|------|------|
| `scripts/archive-rules.js` | 统一规则归档，自动填元数据 | `--rule\|--coin\|--cycle` + `--by` + `--reason` |
| `scripts/query-rules.js` | 多维度检索活跃+归档规则 | `--coin\|--type\|--archived\|--search\|--format` |
| `scripts/add-rule-metadata.js` | 一次性迁移工具 | `--dry-run` 预览 |

模板定义在 `tasks/set-alert.md` C19 块。

### 归档来源枚举

| 值 | 触发场景 |
|----|---------|
| `stage4-cleanup` | 阶段四 B.3 归档失效规则 |
| `trigger-fired` | 引擎触发后自动归档 |
| `cycle-archived` | 阶段四 A.2 周期结束 → 批量清零 |
| `cycle-health-check` | 健康检测静默周期 → 清理 |
| `manual` | 人工执行脚本 |
| `lifetime-expired` | 引擎 lifetime() 过期 / 错误超限 |

---

*备份：TOOLS.md.bak（2026-05-19 精简前）*
