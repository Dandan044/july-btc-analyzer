# 山寨币扫描引擎

此任务为山寨币工作流的入口，负责每小时从 OKX 合约市场扫描波动最大的山寨币，筛选后传递给阶段一。

---

## 触发方式

由定时任务触发（每小时整点 GMT+8）。

---

## 日志文件

**路径：** `logs/alt-scanner.log`

追加模式，记录每轮扫描的开始、候选、筛选、结果。

### 日志异常标识规则

| 级别 | 标识 | 含义 |
|------|------|------|
| **警告** | `⚠️ WARN` | 不影响流程继续 |
| **错误** | `⛔ ERROR` | 需人工关注 |

---

## 前置准备

### 代理

国内访问 OKX API 需要代理。数据获取统一使用：

```bash
curl -s --max-time 15 --proxy http://127.0.0.1:7890 "<url>"
```

---

## 执行步骤

### 步骤 1：记录扫描开始

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] ========== 山寨扫描引擎启动 ========== " >> logs/alt-scanner.log
```

---

### 步骤 2：检查活跃周期数量

```bash
ACTIVE_COUNT=$(ls -d active/alt-* 2>/dev/null | wc -l)
```

**判断：**

| 条件 | 操作 |
|------|------|
| `ACTIVE_COUNT < 20` | 继续扫描 |
| `ACTIVE_COUNT >= 20` | 跳过本轮 |

**日志记录：**

```
[$NOW] [扫描] 活跃周期: ${ACTIVE_COUNT}/20
```

**上限值: 20**（与 `tasks/global-config.json` → `maxAltcoinCycles` 保持同步）。

如果已达上限：

```bash
echo "[$NOW] [扫描] 活跃周期已达上限 (${ACTIVE_COUNT}/MAX)，跳过本轮" >> logs/alt-scanner.log
echo "[$NOW] ========== 扫描结束（上限跳过）========== " >> logs/alt-scanner.log
```

**停止执行，本轮任务完成。**

---

### 步骤 3：获取 OKX SWAP 全量行情

```bash
curl -s --max-time 15 --proxy http://127.0.0.1:7890 \
  "https://www.okx.com/api/v5/market/tickers?instType=SWAP"
```

#### 3.1 过滤合约类型

从返回的 `data[]` 数组中：

- **只保留 `instId` 以 `-USDT-SWAP` 结尾的**
- 丢弃 `-USD-SWAP`、`-USD_UM-SWAP` 等非 USDT 保证金合约

#### 3.2 计算涨跌幅

OKX tickers API 不直接返回 `change24h%`，需要自行计算：

```
涨跌幅% = (last - open24h) / open24h × 100
```

- `last`：最新成交价
- `open24h`：24 小时前开盘价
- `open24h` 为 0 时跳过该币（新上币无历史数据）

#### 3.3 按绝对值排序

按 `|涨跌幅%|` 降序排列，取前 **40** 个作为候选池。

**日志记录：**

```
[$NOW] [扫描] 候选池已生成: 前 40 个（|涨跌幅| 降序）
```

**API 异常处理：**

如果 OKX API 返回错误或超时：

```
[$NOW] [扫描] ⛔ ERROR: OKX API 获取失败 - [错误信息]
```

停止执行。

---

### 步骤 4：逐候选筛选

对候选池中的 40 个币种，按 `|涨跌幅|` 从高到低逐一遍历。**每个币种依次过以下三道筛：**

---

#### ⚠️ 必须使用预写脚本执行筛A+筛B

**筛A（黑名单）+ 筛B（活跃周期）是纯机械逻辑，已经预写在 `scripts/alt-scanner-screening.py` 中。**

**你必须直接执行此脚本，不得自己重写这段逻辑。**

重写的后果：Python 的 `subprocess.run(['ls', '-d', ...])` 不带 `shell=True` 时不会展开 glob 通配符，会导致筛B永远返回「无活跃周期」——这已经在生产环境实际发生过。

操作方式：

```bash
cat /tmp/top40_candidates.json | python3 scripts/alt-scanner-screening.py
```

脚本输出 JSON，结构如下：

```json
{
  "screening": [
    {
      "idx": 0,
      "coin": "JTO",
      "instId": "JTO-USDT-SWAP",
      "change_pct": 40.18,
      "screen_a": "pass",
      "screen_b": "skip (exists: alt-JTO-20260508-0105)",
      "pass_a_and_b": false
    },
    {
      "idx": 8,
      "coin": "APR",
      "change_pct": 30.5,
      "screen_a": "pass",
      "screen_b": "pass",
      "pass_a_and_b": true
    }
  ],
  "first_pass_coin": "APR",
  "first_pass_idx": 8
}
```

字段含义：
| 字段 | 说明 |
|------|------|
| `screen_a` | `"pass"` = 通过黑名单检查；`"skip (blacklisted)"` = 在黑名单中 |
| `screen_b` | `"pass"` = 无活跃周期；`"skip (exists: dirname)"` = 已有活跃周期 |
| `pass_a_and_b` | 是否同时通过 A+B。`true` 的候选才进入筛C |
| `first_pass_coin` | 首个同时通过 A+B 的币种名；全部未通过则 `null` |
| `first_pass_idx` | 该币种在候选池中的索引 |

**读取 `first_pass_coin`：**
- 如果为 `null` → 全部未通过 → 跳到步骤 6
- 如果有值 → 该币种进入筛C（山寨判断）

---

#### 筛 C：判断是否为山寨币

**⚠️ 此筛由 LLM 自行判断，不依赖代码规则。**

你需要根据以下指南判断一个币种是否可以归类为"山寨币"（altcoin），即**具有独立链上生态、可以被三维信息收集流程覆盖的加密货币**。

**必须排除的类型：**

| 类型 | 判断依据 | 示例 |
|------|---------|------|
| **股票代币** | 代币名称匹配知名上市公司股票代码。通常 1-5 个大写字母，无项目社区、无链上生态。 | AAPL, TSLA, AMD, INTC, NVDA, AMZN, GOOGL, META, MSFT, NFLX, PLTR, MU, SNDK, BABA, JD, PDD, BIDU, NIO, XPEV, RIVN, PYPL, SQ, COIN, MARA, RIOT, MSTR |
| **商品/贵金属** | 代币名称匹配大宗商品/贵金属代码。 | XAU(金), XAG(银), XPD(钯), XPT(铂), OIL(原油), NGAS(天然气) |
| **外汇** | 代币名称匹配法币对。 | EUR, GBP, JPY, AUD, CAD, CHF |
| **主流币** | 已是独立分析对象。 | BTC, ETH |

**判断原则：**

当你不确定一个币是否应该排除时，问自己三个问题：

1. **这个代币有独立的区块链/链上数据吗？** 股票代币没有区块链，搜索不到持有者分布、链上交易。
2. **这个代币有独立的社区和媒体叙事吗？** 股票代币的叙事来自公司财报和股市，不是加密货币生态。
3. **阶段一的 onchainOS 搜索能返回有意义的数据吗？** 如果预期链上数据为空，就不该扫。

> 如果你不确定，**宁可跳过也不误判**。跳过只是少扫一个，误判会让整个流程崩溃在阶段一的链上搜索。

**日志记录（每条筛选）：**

```
[$NOW] [筛选] {instId} | 涨跌幅: {±xx.xx}% | 筛C判断: [通过 | 跳过 - 股票代币 | 跳过 - 商品 | 跳过 - 外汇]
```

---

### 步骤 5：通过 → 启动分析

**第一个通过全部三筛的币种 → 立即 spawn 子会话。**

```bash
COIN="{coin}"
TRIGGER_TIME=$(date -Iseconds)
```

**使用 `sessions_spawn`：**

```
- agentId: "july"
- mode: "run"
- model: "deepseek/deepseek-v4-flash"
- task:
  币种: {COIN}
  触发时间: {TRIGGER_TIME}
  请读取 tasks/alt-intel-stage1.md 开始阶段一三维信息收集。
```

> ⚠️ **必须传 model 参数**，否则子会话将继承 agent 默认模型（deepseek-v4-pro），违背 global-config 的山寨币 flash 模型配置。

> 周期目录由阶段一自行创建，无需传递。

**日志记录：**

```
[$NOW] [扫描] ✅ 命中: {instId} | 涨跌幅: {±xx.xx}%
[$NOW] [扫描] 已 spawn 子会话 → alt-intel-stage1
```

**spawn 后本轮扫描结束。**

---

### 步骤 6：全部未通过

**候选池 40 个全部被筛掉 → 记录后退出。**

```
[$NOW] [扫描] 候选池 40 个全部未通过筛选 | 跳过统计: 黑名单 X, 活跃周期 X, 非山寨 X
```

---

### 步骤 7：记录扫描结束

```bash
echo "[$NOW] ========== 扫描结束 ========== " >> logs/alt-scanner.log
```

---

## 完整流程速览

```
获取 OKX SWAP tickers
        │
过滤 -USDT-SWAP、计算 change24h%
        │
按 |change24h%| 降序，取前 40
        │
逐个候选：
  ├─ 筛A: 黑名单？        → 跳过
  ├─ 筛B: active/alt-*-* 已有？→ 跳过
  └─ 筛C: LLM 判断非山寨？ → 跳过
        │
  第一个通过 → spawn(alt-intel-stage1)
  全部未通过 → 记录退出
```

---

## 异常处理

| 异常类型 | 级别 | 处理方式 |
|---------|------|---------|
| OKX API 返回错误/超时 | `⛔ ERROR` | 记录异常，本轮停止 |
| tickers 返回空数组 | `⛔ ERROR` | 记录异常，本轮停止 |
| 所有候选未通过筛选 | 正常 | 记录统计，本轮正常结束 |
| 活跃周期达到上限 | 正常 | 记录跳过，本轮正常结束 |
| spawn 失败 | `⛔ ERROR` | 记录异常，继续尝试下一位 |

---

## 核心要求

1. **先检查上限**：活跃周期 ≥ 20 直接跳过
2. **绝对值排序**：取 `|涨跌幅%|` 最大的前 40，涨跌都纳入
3. **只取 -USDT-SWAP**：忽略 USD/UM 变体
4. **三筛顺序不可变**：黑名单 → 活跃周期 → 山寨判断
5. **筛A+筛B 必须使用预写脚本**：直接执行 `scripts/alt-scanner-screening.py`，不得自己重写
6. **黑名单外部维护**：修改 `data/altcoin-blacklist.json`，添加 `blacklist` 数组项和 `reason` 说明
7. **LLM 自主判断非山寨**：根据指南判断股票/商品/外汇，不硬编码
8. **一次只扫一个**：第一个通过三筛的币就 spawn，本轮结束
9. **不传周期目录**：阶段一自行创建，spawn 只传币种和触发时间
10. **日志完整**：每轮扫描、每个筛选决策都记录

---

## 定时任务配置

| 项目 | 值 |
|------|-----|
| 任务名 | `altcoin-scanner` |
| 频率 | 每小时整点 (GMT+8) |
| 类型 | `cron` `0 * * * *` |
| 会话目标 | 本任务文件 |

---

alt-scanner-v2.0
