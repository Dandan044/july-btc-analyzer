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

### OCO 拆分张数必须对齐 lotSz

`stage3-executor.js` 中拆分两档 OCO 仓位时，张数必须对齐合约的 `lotSz`。

| 币种 | lotSz | 拆分 40% | 错误 | 正确 |
|------|-------|---------|------|------|
| SAHARA | 1 | 96×0.4=38.4 | `--sz 38.4` ❌ | `--sz 38` ✅ |
| 某币 | 0.01 | 96.5×0.4=38.6 | 不处理 | `--sz 38.60` ✅ |

**修复：** 用 `alignToLot = (v) => lotSz > 0 ? Math.floor(v / lotSz) * lotSz : round(v, 4)` 对齐后再传给 OKX。

---

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

### 块作用域变量在延迟确认闭包中的陷阱

延迟确认的 `setTimeout` 回调是闭包，引用外层 `let`/`const` 变量时要注意：
- 如果外层变量在 `setTimeout` 调度后被重新赋值，闭包读到的是最新值而非调度时的值
- 解决：在调度时用临时常量捕获当前值，闭包内引用该常量

```javascript
// ❌ 错误：retracePct 在 setTimeout 回调执行时可能已被覆盖
for (const level of levels) {
  let retracePct = calcRetrace(level);
  setTimeout(() => { if (retracePct > threshold) reset(); }, delay);
}

// ✅ 正确：用 const 捕获当前值
for (const level of levels) {
  const retracePct = calcRetrace(level);  // 块作用域 const
  setTimeout(() => { if (retracePct > threshold) reset(); }, delay);
}
```

---

## 🖼️ 图片处理优先级

> 收到图片分析请求时，**先检查当前模型是否支持多模态**（查看 system prompt 中 Runtime 行的模型名，或检查模型定义中 input 是否包含 "image"）。
>
> **若当前模型支持多模态（输入含 image）：**
> 1. 用 `read` 读取图片 → 图片进入自身上下文 → 原生视觉处理（零损耗，优先）
> 2. 失败或需特殊处理时 → fallback 到 `image` 工具
>
> **若当前模型不支持多模态（输入仅 text）：**
> 1. 用 `image` 工具（外包给外部视觉模型）→ 获取文字描述 → 基于描述回答
> 2. 注意：此时 `image` 工具的模型可能有配额限制
>
> **优先级：原生视觉（read）> 外包视觉（image）> 拒绝**

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

### 山寨币流程

`tasks/alt-pipeline/` — 脚本化山寨币分析全流程的任务文件目录。两条入口（定时扫描 + 警报触发）汇入同一套 stage2/stage3/stage4。LLM 仅参与 sentiment 收集和交叉验证分析，其余全部由脚本（`scripts/scanner-*`、`stage1-*`、`stage3-*`、`stage4-*`）执行。详见 `tasks/alt-pipeline/README.md`。

### 其他脚本

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
| `scripts/sync_positions.js` | BTC 仓位同步 | `tasks/sync-positions.md` |
| `scripts/sync-alt-positions.js` | 山寨币仓位同步 | 阶段一/三调用 |
| `scripts/dispatch.js` | ⚠️ 调度器客户端（所有 cron add 必经） | `--priority --source --name --at --message` |
| `scripts/cron-dispatcher.js` | Cron Add 调度器（PM2 常驻，端口 3102） | 见「基础设施速查 → Cron Add 调度器」 |

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

### Cron Add 调度器

**⚠️ 所有 `openclaw cron add` 调用必须经过调度器，禁止直接调 CLI。**

调度器提供模型负载感知的任务派发，防止模型超载。

```bash
# 提交任务到调度器（通过 dispatch.js 客户端）
node scripts/dispatch.js \
  --priority "med-2" \     # high-3/2/1 | med-2/1 | low-2/1
  --source "scanner" \     # 调用方标识（自由字符串）
  --coin "INJ" \           # 可选，用于去重和日志
  --name "alt-sentiment-INJ-123" \
  --at "10s" \             # now | 5s | 1m | ISO时间戳
  --message "多行消息..."

# 或直接 HTTP POST
curl -X POST http://127.0.0.1:3102/submit \
  -H 'Content-Type: application/json' \
  -d '{"priority":"med-2","source":"scanner","name":"...","at":"10s","message":"..."}'
```

**优先级：** 后缀数字只影响队列排位，HIGH/MED/LOW 决定进哪个模型池。

**PM2 管理：**
```bash
pm2 list | grep cron-dispatcher   # 查看状态
pm2 restart cron-dispatcher        # 重启
```

**配置：** `data/cron-dispatcher-config.json`，可通过 Dashboard 设置页修改池子和模型。

**架构：**
- 调度器 (3102) — 优先级队列 + 载荷感知派发
- Dashboard (3100) — 前端状态面板 + 配置管理
- `scripts/dispatch.js` — 命令行客户端
- 缓存文件 `data/cron-list-cache.json` — 30s 刷新，Dashboard 读缓存不调 gateway

**相关代码：** `scripts/cron-dispatcher.js` `scripts/dispatch.js`

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
