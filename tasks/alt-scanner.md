# 山寨币扫描引擎

此任务为山寨币工作流的入口，负责每小时从 OKX 合约市场扫描波动最大的山寨币，通过中部窗口 + OI 变化筛选，找到趋势中段的入场机会。

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
| `ACTIVE_COUNT < 45` | 继续扫描 |
| `ACTIVE_COUNT >= 45` | 跳过本轮 |

**日志记录：**

```
[$NOW] [扫描] 活跃周期: ${ACTIVE_COUNT}/45
```

**上限值: 45**（与 `tasks/global-config.json` → `maxAltcoinCycles` 保持同步）。

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

按 `|涨跌幅%|` 降序排列，取前 **60** 个作为候选池。

**日志记录：**

```
[$NOW] [扫描] 候选池已生成: 前 60 个（|涨跌幅| 降序）
```

**API 异常处理：**

如果 OKX API 返回错误或超时：

```
[$NOW] [扫描] ⛔ ERROR: OKX API 获取失败 - [错误信息]
```

停止执行。

---

### 步骤 4：初始化窗口

**窗口策略：从中部开始，逐步扩展**

| 轮次 | 窗口范围 | 索引（0-based） | 窗口大小 |
|------|---------|----------------|---------|
| 1 | 26-30 | 25-29 | 5 |
| 2 | 21-35 | 20-34 | 15 |
| 3 | 11-50 | 10-49 | 40 |
| 4 | 1-60 | 0-59 | 60 |

**初始化：**

```bash
WINDOW_ROUND=1
CHECKED_COINS=()  # 已检查的币种（避免重复检查）
```

**日志记录：**

```
[$NOW] [扫描] 窗口: 第${WINDOW_ROUND}轮（26-30，共 5 个）
```

---

### 步骤 5：窗口内筛选（筛A+B+C）

**⚠️ 必须使用预写脚本执行筛A+筛B**

**筛A（黑名单）+ 筛B（活跃周期）是纯机械逻辑，已经预写在 `scripts/alt-scanner-screening.py` 中。**

操作方式：

```bash
# 将窗口内币种传入筛选脚本
echo "${WINDOW_COINS_JSON}" | python3 scripts/alt-scanner-screening.py
```

脚本输出 JSON，结构如下：

```json
{
  "screening": [
    {
      "idx": 26,
      "coin": "DOGE",
      "instId": "DOGE-USDT-SWAP",
      "change_pct": 15.2,
      "screen_a": "pass",
      "screen_b": "pass",
      "pass_a_and_b": true
    }
  ],
  "passed_coins": ["DOGE", "PEPE"],
  "filtered_coins": ["BOME"]
}
```

**筛C：LLM 判断是否为山寨币**

对通过筛A+B 的币种，执行筛C判断。

**⚠️ 此筛由 LLM 自行判断，不依赖代码规则。**

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

**日志记录：**

```
[$NOW] [筛选] 窗口内通过筛A+B: X 个 | 筛C通过: Y 个 | 被筛: Z 个
```

**结果判断：**

| 结果 | 操作 |
|------|------|
| 有币种通过筛A+B+C | 进入步骤 6（OI 筛选） |
| 全部被筛掉 | 进入步骤 8（窗口扩展） |

---

### 步骤 6：OI 变化筛选

**对通过筛A+B+C 的币种，获取 24h OI 变化率。**

**使用预写脚本：**

```bash
# 将通过筛A+B+C 的币种传入 OI 筛选脚本
echo "${PASSED_COINS_JSON}" | python3 scripts/alt-scanner-oi-filter.py
```

脚本输出 JSON：

```json
{
  "ranked": [
    {
      "coin": "PEPE",
      "change_pct": -12.8,
      "idx": 27,
      "oi_change_pct": 24.21
    },
    {
      "coin": "SOL",
      "change_pct": -5.1,
      "idx": 2,
      "oi_change_pct": 10.54
    }
  ],
  "top_pick": {
    "coin": "PEPE",
    "change_pct": -12.8,
    "oi_change_pct": 24.21
  }
}
```

**排序规则：按 OI 变化率绝对值降序，选最大的。**

**日志记录：**

```
[$NOW] [OI筛选] 获取 OI 变化: PEPE +24.21%, SOL +10.54%, DOGE +2.23%
[$NOW] [OI筛选] 排序结果: PEPE > SOL > DOGE
```

---

### 步骤 7：通过 → 启动分析

**从 OI 筛选结果中取出 top_pick，spawn 子会话。**

```bash
COIN="${top_pick['coin']}"
OI_CHANGE="${top_pick['oi_change_pct']}"
OI_CONFIRMED="${top_pick['oi_confirmed']}"
TRIGGER_TIME=$(date -Iseconds)
```

**使用 `sessions_spawn`：**

```
- agentId: "july"
- mode: "run"
- task:
  币种: {COIN}
  触发时间: {TRIGGER_TIME}
  请读取 tasks/alt-intel-stage1.md 开始阶段一三维信息收集。
```

> 周期目录由阶段一自行创建，无需传递。

**日志记录：**

```
[$NOW] [扫描] ✅ 命中: {COIN} | 涨跌幅: {±xx.xx}% | OI变化: {±xx.xx}% | 窗口轮次: {N}
[$NOW] [扫描] 已 spawn 子会话 → alt-intel-stage1
```

**spawn 后本轮扫描结束。**

---

### 步骤 8：窗口扩展

**当前窗口全部被筛 → 扩大窗口，继续扫描。**

**窗口扩展规则：**

| 轮次 | 窗口范围 | 索引 | 新增检查 |
|------|---------|------|---------|
| 1 | 26-30 | 25-29 | 5 |
| 2 | 21-35 | 20-34 | 10（上扩5 + 下扩5）|
| 3 | 11-50 | 10-49 | 25（上扩10 + 下扩15）|
| 4 | 1-60 | 0-59 | 20（上扩10 + 下扩10）|

**扩展逻辑：**

```bash
# 记录已检查的币种
CHECKED_COINS+=("${WINDOW_COINS[@]}")

# 扩大窗口
WINDOW_ROUND=$((WINDOW_ROUND + 1))

# 判断是否已检查全部
if [ $WINDOW_ROUND -gt 4 ]; then
  # 全部 60 个已检查，无通过
  echo "[$NOW] [扫描] 候选池 60 个全部未通过筛选" >> logs/alt-scanner.log
  # 进入步骤 9
fi

# 计算新窗口范围
case $WINDOW_ROUND in
  2) WINDOW_START=20; WINDOW_END=34 ;;
  3) WINDOW_START=10; WINDOW_END=49 ;;
  4) WINDOW_START=0; WINDOW_END=59 ;;
esac

# 只检查新增的币种（排除已检查的）
NEW_WINDOW_COINS=()
for i in $(seq $WINDOW_START $WINDOW_END); do
  if [[ ! " ${CHECKED_COINS[@]} " =~ " ${CANDIDATES[$i]} " ]]; then
    NEW_WINDOW_COINS+=("${CANDIDATES[$i]}")
  fi
done

# 回到步骤 5 继续筛选
```

**日志记录：**

```
[$NOW] [扫描] 窗口扩展: 第${WINDOW_ROUND}轮（${WINDOW_START+1}-${WINDOW_END+1}，共 ${NEW_COUNT} 个新增）
```

---

### 步骤 9：全部未通过

**候选池 60 个全部被筛掉 → 记录后退出。**

```
[$NOW] [扫描] 候选池 60 个全部未通过筛选 | 跳过统计: 黑名单 X, 活跃周期 X, 非山寨 X, OI未确认 X
```

---

### 步骤 10：记录扫描结束

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
按 |change24h%| 降序，取前 60
        │
初始化窗口：中部 5 个（26-30）
        │
        ▼
   ┌─────────────────────────────┐
   │  窗口内筛选（筛A+B+C）       │
   └─────────────────────────────┘
        │
   有通过 → OI 筛选 → spawn 分析
        │
   全部被筛 → 扩大窗口
        │
   窗口已达上限 → 记录退出
```

---

## 异常处理

| 异常类型 | 级别 | 处理方式 |
|---------|------|---------|
| OKX API 返回错误/超时 | `⛔ ERROR` | 记录异常，本轮停止 |
| tickers 返回空数组 | `⛔ ERROR` | 记录异常，本轮停止 |
| OI API 获取失败 | `⚠️ WARN` | 记录警告，OI 视为未确认，仍可参与排序 |
| 所有候选未通过筛选 | 正常 | 记录统计，本轮正常结束 |
| 活跃周期达到上限 | 正常 | 记录跳过，本轮正常结束 |
| spawn 失败 | `⛔ ERROR` | 记录异常，继续尝试下一位 |

---

## 核心要求

1. **先检查上限**：活跃周期 ≥ 45 直接跳过
2. **绝对值排序**：取 `|涨跌幅%|` 最大的前 60，涨跌都纳入
3. **只取 -USDT-SWAP**：忽略 USD/UM 变体
4. **从中部开始扫描**：第 26-30 位，避开极端位置
5. **逐步扩展窗口**：中部无机会时，向上下扩展
6. **OI 变化筛选**：按 OI 变化率绝对值排序，选最大的
7. **筛A+筛B 必须使用预写脚本**：直接执行 `scripts/alt-scanner-screening.py`
8. **OI 筛选必须使用预写脚本**：直接执行 `scripts/alt-scanner-oi-filter.py`
9. **黑名单外部维护**：修改 `config/altcoin-blacklist.json`
10. **LLM 仅参与筛C**：筛A/B 是机械逻辑，筛C 需要语义判断
11. **一次只扫一个**：第一个通过全部筛选的币就 spawn，本轮结束
12. **不传周期目录**：阶段一自行创建，spawn 只传币种和触发时间
13. **日志完整**：每轮扫描、每个筛选决策都记录

---

## 定时任务配置

| 项目 | 值 |
|------|-----|
| 任务名 | `altcoin-scanner` |
| 频率 | 每小时整点 (GMT+8) |
| 类型 | `cron` `0 * * * *` |
| 会话目标 | 本任务文件 |

---

## 相关脚本

| 脚本 | 职责 |
|------|------|
| `scripts/alt-scanner-screening.py` | 筛A（黑名单）+ 筛B（活跃周期）|
| `scripts/alt-scanner-oi-filter.py` | OI 变化获取与排序 |

---

alt-scanner-v3.0（中部窗口 + OI 筛选）
