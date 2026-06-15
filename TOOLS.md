# TOOLS.md - 七月工具笔记

> 按出错代价排序。先看陷阱，再看数据，最后查脚本。
> 提示词设计哲学：`~/.openclaw/PROMPT_DESIGN_PHILOSOPHY.md`（给维度不给规则，给问题不给答案）

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

### OCO 拆分张数必须对齐 lotSz + 防浮点精度泄露

`stage3-executor.js` 中拆分两档 OCO 仓位时，张数必须对齐合约的 `lotSz`。

| 币种 | lotSz | 拆分 40% | 错误 | 正确 |
|------|-------|---------|------|------|
| SAHARA | 1 | 96×0.4=38.4 | `--sz 38.4` ❌ | `--sz 38` ✅ |
| 某币 | 0.01 | 96.5×0.4=38.6 | 不处理 | `--sz 38.60` ✅ |

**修复：** `alignToLot = (v) => lotSz > 0 ? round(Math.floor(v / lotSz) * lotSz, 8) : round(v, 4)`

#### ⚠️ 浮点精度泄露（2026-05-29 血案）

`Math.floor(v / lotSz) * lotSz` 会产生不可见的浮点尾巴：
- `23 * 0.1` 在 IEEE 754 中 = `2.3000000000000003`（不是 2.3！）
- OKX 看到 `--sz 2.3000000000000003` 直接拒绝，重试三次全部失败

**所有传给 OKX 的 `--sz` 值，在最后一步必须经过 `round()` 消除浮点尾巴。**

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

### 代理配置

**统一入口**：所有脚本从 `PROXY_URL` 环境变量读取代理地址。

```bash
# 初始化（写入 ~/.bashrc 持久化）
export PROXY_URL="http://127.0.0.1:7890"   # 国内用户：替换为你的代理端口
# export PROXY_URL=""                       # 国外用户：不需要代理

# 或使用配置文件
source config/proxy.env
```

> 未设置 `PROXY_URL` 时，所有脚本自动 fallback 到 `http://127.0.0.1:7890`。
> 所有 `curl`/`subprocess` 调用、`ecosystem.config.js` 的 PM2 环境变量均由此统一管理。
> `proxychains4` 有独立的配置文件（`/etc/proxychains4.conf`），需单独配置。

### OKX API
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

`tasks/pipeline/` — 山寨币/庄币分析流程的统一任务文件目录。双画像（alt + zhuang）共享模块化阶段二（9 个模块 + JSON 清单组装），详见 `tasks/pipeline/README.md`。

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
| `scripts/sync-alt-positions.js` | 山寨币仓位同步 | 阶段一/三调用。⚠️ OCO 覆盖检查已修复（多档拆分不再误报） |
| `scripts/dispatch.js` | ⚠️ 调度器客户端（所有 cron add 必经） | `--priority --source --name --at --message` |
| `scripts/cron-dispatcher.js` | Cron Add 调度器（PM2 常驻，端口 3102） | 见「基础设施速查 → Cron Add 调度器」 |

### 监督者机制

| 文件 | 用途 |
|------|------|
| `data/supervisor-config.json` | 监督者开关配置（monitoredActions + minPositionsForTrigger） |
| `tasks/supervisor-blind.md` | 盲测阶段：独立市场评估 |
| `tasks/supervisor-review.md` | 审查阶段：交叉对比 + 规则评估 |
| `scripts/stage3-executor.js` | `--supervisor` 参数控制开仓/加仓是否路由至监督者 |

> 触发条件：开仓/加仓（由 `monitoredActions` 控制）+ 全周期持仓总数 > `minPositionsForTrigger`（默认 5，Dashboard 设置页可调）。持仓 ≤ 阈值时跳过监督者，避免小仓位过度拦截。
> 模型由调度器 `high-2` 优先级池决定，与七月模型不同以保证独立视角。

### 持仓全面审视（position-monitor）

| 文件 | 用途 |
|------|------|
| `scripts/position-monitor.js` | PM2 常驻进程（每 3h 检查实盘持仓 + 派发审计任务） |
| `tasks/position-monitor.md` | 审计智能体规则：逐仓位盈亏复查 + 市场环境复核 + 决策执行 |
| `data/position-monitor-cache.json` | 每次派发前写入的持仓快照，供审计智能体读取 |

> 仅当 OKX 实盘持仓 > 0 时触发。使用 `pro` 优先级（ds-pro 池，DeepSeek V4 Pro）。

---

## ⚙️ 基础设施速查

### OKX 交易 CLI

包装器：`scripts/okx-proxy.sh`。完整命令参考：`okx-cex-trade` / `okx-cex-market` / `okx-cex-portfolio` 三个 skill。

⚠️ 减仓用反向市价单，不能用 `swap close`（会全平）。

**OKX CLI 直接调用（监督者使用）**：`okx market ticker/candles/orderbook/funding-rate ...`

### 模型温度

七月 + DeepSeek 模型 temperature 已设为 0.3（`~/.openclaw/openclaw.json` → `models.providers.*.models[].params.temperature`）。减少高温下的叙事生成，增强分析严谨性。

### OnchainOS 链上数据

CLI：`onchainos`（v2.5.0，`~/.local/bin/onchainos`）。完整参考：`okx-dex-token/SKILL.md`。

### PM2 进程管理

所有 PM2 服务配置在 `ecosystem.config.js`。

```bash
# 查看所有服务
pm2 list

# 警报器引擎
pm2 logs btc-alert
pm2 restart btc-alert

# 持仓审计
pm2 logs position-monitor
pm2 restart position-monitor

pm2 save
```

### Web Search

**Provider: SearXNG（自建，Docker 容器）** `tools.web.search.provider: searxng`

```bash
# 容器管理
sudo docker ps --filter name=searxng   # 查看状态
sudo docker restart searxng            # 重启
sudo docker logs searxng --tail 20     # 日志

# 配置位置
~/.config/searxng/settings.yml        # SearXNG 配置
~/.openclaw/openclaw.json             # OpenClaw provider 配置
```

**架构：**
```
web_search → SearXNG (localhost:8888) → 172.17.0.1:7890 (mihomo) → 上游引擎
```

**引擎配置（settings.yml）：**
| 引擎 | 状态 | 原因 |
|------|------|------|
| Bing ✓ | 启用 | 稳定 |
| Brave ✓ | 启用 | 稳定（单发） |
| Yahoo ✓ | 启用 | 稳定 |
| Wikipedia ✓ | 启用 | 最稳定 |
| Wikidata ✓ | 启用 | 知识图谱 |
| Google ✗ | 禁用 | 反爬封 IP |
| DuckDuckGo ✗ | 禁用 | CAPTCHA |

**⚠️ 并发限制**：同一代理 IP 并发 > 2-3 可能触发 Brave/Bing 限流（180s）。
实际 pipeline 串行处理（逐个币种），不受影响。

**代理依赖**：SearXNG 容器内部通过 `172.17.0.1:7890` 走宿主机 mihomo 代理。
宿主机代理必须运行（端口 7890），否则搜索返回 0 结果。

**Docker 守护进程**：WSL2 无 systemd，自启脚本在 `.bashrc`。
终端启动后自动拉起 dockerd → SearXNG 容器。

**历史**：2026-06-10 从 DuckDuckGo（bot-detection 全面封锁）迁移到 SearXNG。
恢复前曾测试 Exa（已有 key）作为候选方案，未实际使用。

**相关文档：** `~/.npm-global/lib/node_modules/openclaw/docs/tools/searxng-search.md`
`~/.npm-global/lib/node_modules/openclaw/docs/tools/web.md`

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

```bash
# 使用指定 SSH 密钥推送（替换为你的密钥路径）
GIT_SSH_COMMAND="ssh -i <你的SSH私钥路径>" git push
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

### stage3 市场环境对冲（阶段三 y 系数）

**保留 corr 符号：负相关=自然对冲→放大仓位，正相关=跟大盘→顺势放逆势收。**

```
y = 1.0 + marketScore × corr × 0.5 + sectorScoreNorm × 0.15

marketScore = dirSign × score / 10
corr = Pearson R (BTC, ALT)  // 保留原始符号，≥0 跟大盘, <0 逆市
```

| marketScore × corr | 含义 | y |
|---|---|---|
| > 0 | 仓位有自然对冲（大盘跌+庄股涨+做多） | 放大 |
| < 0 | 相关系数放大了方向风险（大盘跌+跟跌币+做多） | 缩减 |
| = 0 | 无相关信息（corr=0） | 不调整 |

- 负相关=庄家控盘强，市场越不利仓位越有保护 → 放大
- 正相关=跟大盘走，顺势放大逆势缩减

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
