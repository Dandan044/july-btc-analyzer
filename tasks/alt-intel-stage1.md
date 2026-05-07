# 山寨币任务 - 阶段一：三维信息收集

此任务为山寨币工作流的第一阶段，负责周期创建、三维数据采集（媒体+链上+合约）、生成数据清单。

---

## 触发方式

由山寨币扫描引擎（`tasks/alt-scanner.md`）通过 `sessions_spawn` 触发。

**入参格式**（由扫描引擎传递）：

```
币种: {COIN}
触发时间: {YYYY-MM-DDTHH:MM:SS+08:00}
请读取 tasks/alt-intel-stage1.md 开始阶段一三维信息收集。
```

> 周期目录由阶段一步骤 2 自行创建，无需传递。

---

## 日志文件

**路径：** `logs/alt-{COIN}-process.log`

此日志记录该币种四阶段的完整执行过程，追加模式。

### 日志异常标识规则

| 级别 | 标识 | 含义 | 示例 |
|------|------|------|------|
| **警告** | `⚠️ WARN` | 不影响流程继续执行，但需关注 | 某维度数据部分缺失 |
| **错误** | `⛔ ERROR` | 可能影响后续阶段，需人工介入 | 全部数据获取失败、文件创建失败 |

**区分原则：**

| 场景 | 级别 | 原因 |
|------|------|------|
| 合约数据获取成功但部分字段缺失 | `⚠️ WARN` | 数据仍可用，阶段二可判断 |
| 某维度数据完全获取失败 | `⚠️ WARN` | 还有其他维度可用 |
| 全部三维数据获取失败 | `⛔ ERROR` | 无数据无法分析 |
| 媒体搜索结果为空 | `⚠️ WARN` | 标记无媒体信号 |
| 链上数据获取失败 | `⚠️ WARN` | 非必选项，继续 |
| 合约数据脚本执行失败 | `⛔ ERROR` | 核心数据缺失 |
| 周期文件夹创建失败 | `⛔ ERROR` | 无法保存后续文件 |
| 数据清单 JSON 生成失败 | `⛔ ERROR` | 阶段二无法获知路径 |

**日志格式：**

```
正常: [时间] [阶段一] 内容
警告: [时间] [阶段一] ⚠️ WARN: 内容
错误: [时间] [阶段一] ⛔ ERROR: 内容
```

---

## 执行步骤

### 步骤 1: 记录阶段开始

```bash
COIN="{COIN}"  # 由入参提供
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段一] ========== 山寨币分析启动 | 币种: $COIN ========== " >> logs/alt-${COIN}-process.log
echo "[$NOW] [阶段一] 开始执行 - 三维信息收集" >> logs/alt-${COIN}-process.log
```

---

### 步骤 2: 检查周期状态并创建文件夹

**只负责检测和创建，不读取周期内的交易建议内容。**

```bash
# 检查该币种是否已有活跃周期
ls -d active/alt-${COIN}-* 2>/dev/null
```

**情况A：无活跃周期 → 创建新周期**
- 创建新周期文件夹：`alt-{COIN}-YYYYMMDD-HHMM`
- 创建子文件夹结构：`reports/`、`data-context/`

```bash
CYCLE_DIR="alt-${COIN}-$(date +%Y%m%d)-$(date +%H%M)"
mkdir -p active/${CYCLE_DIR}/reports
mkdir -p active/${CYCLE_DIR}/data-context
```

**情况B：已有活跃周期 → 复用**
- 记录已有的周期 ID
- 确认 `data-context/` 子文件夹存在（不存在则创建）

```bash
CYCLE_DIR=$(ls -td active/alt-${COIN}-* 2>/dev/null | head -1 | xargs basename)
mkdir -p active/${CYCLE_DIR}/data-context
```

**日志记录：**
```
[$NOW] [阶段一] 周期状态: active/alt-{COIN}-YYYYMMDD-HHMM (新建/复用)
```

---

### 步骤 3: 同步该币种持仓

**任务路由：** 读取 `tasks/sync-positions.md` 执行持仓同步任务。

**输入参数：**

| 参数 | 值 |
|------|-----|
| 币种 | `{COIN}`（由入参提供） |
| 周期文件夹路径 | `active/{CYCLE_DIR}` |
| 日志文件路径 | `logs/alt-{COIN}-process.log` |
| 仓位模式 | `cross`（全仓） |

**输出产物：**
- 持仓文件：`active/{CYCLE_DIR}/positions.json`（包含 `币种` 字段标识币种）

**日志记录：**
```
[$NOW] [阶段一] 持仓同步路由: 读取 tasks/sync-positions.md (coin={COIN}, mode=cross)
```

> `sync-positions.md` 已参数化支持任意币种和仓位模式，执行时筛选 `{COIN}-USDT-SWAP` 全仓持仓。

---

### 步骤 4: 收集同币种历史报告

**⚠️ 只收集路径，不读取内容。阶段二自行读取。**

只允许读取 `active` 文件夹中的内容完成本步骤，不允许读取 `archived` 文件夹中的历史报告。

从 `active/` 下所有该币种的周期文件夹中列出报告文件：
- 分析报告（`alt-report-*.md`）

**收集规则：**
- 同币种：只收集 `active/alt-{COIN}-*/` 目录下的报告
- 按时间倒序排列
- 最多 **5 篇**
- 排除当前周期自身（`grep -v "${CYCLE_DIR}"`）

**路径收集方式（仅列出文件名）：**

```bash
# 列出该币种历史报告（仅 active/ 下）
ls -t active/alt-${COIN}-*/reports/alt-report-*.md 2>/dev/null | grep -v "${CYCLE_DIR}" | head -5
```

**如果没有历史报告（该币种首次被扫）：** 标记 `note: "{COIN} 首次分析，无历史报告"`。

**日志记录：**
```
[$NOW] [阶段一] 历史报告收集: {COIN} 找到 N 篇
```

> 若无历史报告，正常继续。

---

### 步骤 5: 收集消息面 & 链上数据

**任务路由：** 读取 `tasks/alt-intel-sentiment.md` 执行媒体搜索和链上数据收集。

**输入参数：**

| 参数 | 值 |
|------|-----|
| 币种 | `{COIN}` |
| 周期文件夹路径 | `active/{CYCLE_DIR}` |
| 日志文件路径 | `logs/alt-{COIN}-process.log` |

**输出产物：**
- `{CYCLE_DIR}/data-context/sentiment-media.md` — 消息面总结
- `{CYCLE_DIR}/data-context/sentiment-onchain.md` — 链上数据归纳

**日志记录：**
```
[$NOW] [阶段一] 消息面&链上路由: 读取 tasks/alt-intel-sentiment.md (coin={COIN})
```

> 两个维度独立执行、互不阻塞，结果由阶段一汇总写入数据清单。

---

### 步骤 6: 维度三 — 合约技术数据

使用现有的数据获取脚本，获取该币种的合约技术面数据。

```bash
# 获取合约市场数据（使用山寨专用脚本）
node skills/btc-market-lite/scripts/get_altcoin_analysis.js \
  --coin {COIN} \
  --json \
  --save \
  --proxy http://127.0.0.1:7890
```

> ⚠️ `--save` 默认保存到 `data/YYYY-MM-DD.json`。执行后需重命名为 `data/{COIN}-YYYY-MM-DD.json`：

```bash
mv data/$(date +%Y-%m-%d).json data/${COIN}-$(date +%Y-%m-%d).json
```

#### 6.1 数据覆盖

脚本获取的数据维度：

| 数据 | 说明 |
|------|------|
| 日线 K线 (1D) | 14根 | 含 EMA 均线 (7/12/20/26) |
| 4H K线 | 14根 | 含 OI、多空比、Taker 买卖比 |
| 1H K线 | 14根 | 🆕 含 OI、多空比、Taker 买卖比 |
| 15min K线 | 14根 | 🆕 含 EMA(7/12) 短线动量 |
| 资金费率 | 当前 + 历史序列 |
| 持仓量 (OI) | 多周期 |
| 多空人数比 | 多周期 |
| Taker买卖比 | 多周期 |
| 清算数据 | 24H 多空分布 |
| 斐波那契 | 日线/4H/周线 |

**执行结果判断：**

| 结果 | 日志记录 | 清单标记 |
|------|---------|---------|
| 成功 | `[阶段一] 合约数据获取: 成功` | `status: "success"` |
| 失败 | `[阶段一] ⛔ ERROR: 合约数据脚本执行失败` | `status: "failed"` |

---

### 步骤 7: 输出数据清单 JSON

生成固定格式的数据清单，供阶段二读取。

**保存路径：** `active/{CYCLE_DIR}/data-context/data-manifest-{COIN}-YYYY-MM-DD-HHMM.json`

**JSON 格式：**

```json
{
  "manifest_version": "1.0",
  "stage": "altcoin-intel",
  "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00",

  "coin": {
    "symbol": "DOGE",
    "cycle_dir": "alt-DOGE-20260503-1200",
    "started_at": "YYYY-MM-DDTHH:MM:SS+08:00"
  },

  "positions": {
    "file": "alt-DOGE-20260503-1200/positions.json",
    "current_count": 0,
    "has_existing": false
  },

  "history_reports": {
    "coin": "DOGE",
    "reports": [
      {
        "path": "active/alt-DOGE-20260501-0800/reports/alt-report-2026-05-01-0815.md",
        "date": "2026-05-01",
        "cycle_id": "alt-DOGE-20260501-0800"
      }
    ],
    "total_count": 1,
    "note": "2天前历史报告"
  },

  "data_collected": {
    "sentiment_media": {
      "file": "alt-DOGE-20260503-1200/data-context/sentiment-media.md",
      "status": "success"
    },
    "sentiment_onchain": {
      "file": "alt-DOGE-20260503-1200/data-context/sentiment-onchain.md",
      "status": "partial",
      "note": "部分链上数据获取成功"
    },
    "contract": {
      "status": "success",
      "data_file": "data/DOGE-2026-05-03.json",
      "source": "OKX API",
      "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00"
    }
  },

  "next_stage": {
    "task_file": "tasks/alt-intel-stage2.md",
    "spawn_instruction": "阶段一三维信息收集已完成，请读取 data-manifest 开始阶段二交叉验证分析。"
  }
}
```

**日志记录：**
```
[$NOW] [阶段一] 数据清单已生成: data-context/data-manifest-{COIN}-YYYY-MM-DD-HHMM.json
```

---

### 步骤 8: 记录阶段结束

阶段一完成。输出当前进度和数据清单路径。

**步骤 8.1：记录进度**

在回复中输出：

```
阶段一三维信息收集已完成。
币种: {COIN}
周期: active/{CYCLE_DIR}
数据清单: active/{CYCLE_DIR}/data-context/data-manifest-{COIN}-YYYY-MM-DD-HHMM.json
```

**步骤 8.2：记录日志**

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段一] ========== 阶段一结束 ========== " >> logs/alt-${COIN}-process.log
```

---

## 阶段过渡

输出数据清单路径后，立即读取并执行 `tasks/alt-intel-stage2.md`。数据清单已包含周期、币种、持仓、三维数据状态、历史报告等全部上下文，阶段二读取清单即可获取所有参数。

---

## 异常处理

| 异常类型 | 级别 | 处理方式 |
|---------|------|---------|
| 合约数据脚本执行失败 | `⛔ ERROR` | 清单标记 `status: "failed"`，阶段二仅凭媒体+链上分析 |
| 全部三维数据获取失败 | `⛔ ERROR` | 记录异常，结束本阶段，不进入阶段二 |
| 媒体搜索结果全部过期/为空 | `⚠️ WARN` | 标记无媒体信号，继续执行 |
| 链上数据获取失败 | `⚠️ WARN` | 标记缺失，继续执行 |
| 合约数据部分字段缺失 | `⚠️ WARN` | 标记缺失字段，继续执行 |
| 周期文件夹创建失败 | `⛔ ERROR` | 记录异常，结束本阶段 |
| 持仓查询失败 | `⚠️ WARN` | 标记持仓未知，继续执行 |
| 数据清单 JSON 生成失败 | `⛔ ERROR` | 记录异常后结束本阶段 |

**不因警告中断流程，错误视情况决定是否继续。**

---

## 核心要求

1. **首先记录阶段开始**：日志优先，先记录再执行
2. **三维并行收集**：媒体、链上、合约三个维度各自独立获取，互不阻塞
3. **无数据挖掘**：阶段一只收集原始数据，不做任何数据挖掘或洞察提炼
4. **时效性过滤**：媒体消息 >7天自动忽略
5. **收集同币种历史报告**：只从 `active/` 下收集同一 COIN 的过往报告（最多 5 篇），不读内容只收集路径
6. **必须生成数据清单 JSON**：固定格式，包含三维数据状态、历史报告路径和文件路径
7. **数据命名规范**：合约数据保存为 `data/{COIN}-YYYY-MM-DD.json`
8. **日志按币种隔离**：`logs/alt-{COIN}-process.log`
9. **完成后继续阶段二**：输出数据清单路径，读取 `tasks/alt-intel-stage2.md`
10. **异常分级记录**：`⚠️ WARN` 不中断，`⛔ ERROR` 视情况处理

---

## 经验教训

### ⚠️ onchainOS 链上搜索必须多链回退（2026-05-05，LAB）

**问题：** 执行 LAB 币种阶段一时，`onchainos token search --query LAB` 默认仅搜索 Ethereum (chain 1) 和 Solana (chain 501)，返回了大量无关同名代币（The Professor、HAIRDAO LABORATORY 等），没有 LAB 主代币。执行者误判为「链上数据获取失败」，标注 `status: failed`。

**根因：** LAB 主代币位于 **BSC (chain 56)**，不在 onchainOS 默认搜索范围内。`alt-intel-sentiment.md` 虽已写明 `--chains` 参数的用法，但执行时未遵循多链回退策略。

**纠正后结果：** 指定 `--chains "56"` 重新搜索，在 BSC 链上找到 LAB 主代币合约 `0x7ec43cf65f1663f820427c62a5780b8f2e25593a`（18,754 持有者、$180M 市值）。集群分析揭示了关键风险：Top 100 持仓 99.8%、跑路风险 100%、46.4% 同源资金。

**教训：**
1. **默认搜索无果 ≠ 数据不存在**。必须先尝试常见替代链（BSC=56, Arbitrum=42161, Base=8453, Polygon=137）
2. **多链回退是强制步骤**，不应在首次搜索失败后就标注 `status: failed`
3. 已更新 `alt-intel-sentiment.md` 强制执行多链搜索策略，确保不会因链不匹配而遗漏数据

---

阶段一 - v1.2
