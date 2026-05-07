# 山寨币即时分析 - 阶段一：警报数据获取

此任务为山寨币即时分析工作流的第一阶段，由警报触发。负责解析警报数据、获取即时合约数据、定位已有周期、生成数据清单。

与常规阶段一的区别：**不复跑三维收集**——复用周期创建时的媒体/链上数据，只补充最新的合约技术数据。

---

## 触发方式

由警报规则 `trigger()` 通过 CLI spawn 触发。入参为 JSON 警报数据 + 阶段指令。

**入参格式：**

```
{...JSON警报数据...}

以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行技术分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。
```

---

## 日志文件

**路径：** `logs/alt-{COIN}-process.log`

与常规四阶段共用同一进程日志，追加模式。

### 日志异常标识规则

| 级别 | 标识 | 含义 |
|------|------|------|
| **警告** | `⚠️ WARN` | 不影响流程继续 |
| **错误** | `⛔ ERROR` | 可能影响后续阶段 |

---

## 执行步骤

### 步骤 1：解析警报数据并记录阶段开始

**从上一步消息中提取 JSON 警报数据。**

```javascript
// 消息格式：{JSON}\n\n以上为警报触发数据...
// 取第一个空行之前的内容作为 JSON
const jsonStr = taskMessage.split('\n\n以上为警报触发数据')[0];
const alertData = JSON.parse(jsonStr);
```

**提取关键字段：**

| 字段 | 说明 | 用途 |
|------|------|------|
| `coin` | 币种符号 | ⚠️ 必须存在，定位周期和获取数据 |
| `alertName` | 警报规则名称 | 记录日志 |
| `alertTime` | 触发时间 | 清单时间戳 |
| `currentPrice` | 当前价格 | 上下文 |
| `triggerPrice` | 触发价位 | 上下文 |
| `alertType` | 警报类型 | price / oi / funding 等 |
| 其他字段 | 警报 collect() 携带的数据 | 传递给阶段二分析 |

> ⚠️ `coin` 字段是必选项。警报规则 `collect()` 必须返回此字段。

**记录阶段开始：**

```bash
COIN="{从警报数据提取的 coin}"
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] ========== 山寨即时分析启动 | 币种: $COIN | 警报: {alertName} ========== " >> logs/alt-${COIN}-process.log
echo "[$NOW] [即时分析阶段一] 开始执行 - 警报数据解析" >> logs/alt-${COIN}-process.log
```

---

### 步骤 2：定位该币种活跃周期

**⚠️ 即时分析不创建新周期——该币种必定已有活跃周期（有交易才会设警报）。**

```bash
CYCLE_DIR=$(ls -td active/alt-${COIN}-* 2>/dev/null | head -1 | xargs basename)
```

**判断：**

| 结果 | 处理 |
|------|------|
| 找到周期 | 继续执行 |
| 未找到周期 | ⛔ ERROR，该币种无活跃周期，无法执行即时分析 |

**未找到周期时：**

```
[$NOW] [即时分析阶段一] ⛔ ERROR: 未找到活跃周期 active/alt-${COIN}-*，无法执行即时分析
```

**停止执行。**

**日志记录：**

```
[$NOW] [即时分析阶段一] 周期定位: active/${CYCLE_DIR} (复用)
```

---

### 步骤 3：获取即时合约数据

**只获取最新合约数据，不重跑媒体搜索和链上数据。**

```bash
node skills/btc-market-lite/scripts/get_altcoin_analysis.js \
  --coin ${COIN} \
  --json \
  --save \
  --proxy http://127.0.0.1:7890
```

脚本保存到 `data/{日期}-{COIN}.json`，重命名为即时数据文件：

```bash
mv data/$(date +%Y-%m-%d)-${COIN}.json data/${COIN}-instant-$(date +%Y%m%d)-$(date +%H%M).json
INSTANT_DATA_FILE=$(ls -t data/${COIN}-instant-*.json | head -1)
```

**执行结果判断：**

| 结果 | 日志记录 | 清单标记 |
|------|---------|---------|
| 成功 | `[即时分析阶段一] 合约数据获取: 成功` | `status: "success"` |
| 失败 | `[即时分析阶段一] ⛔ ERROR: 合约数据脚本执行失败` | `status: "failed"` |

---

### 步骤 4：复用已有媒体和链上数据

**⚠️ 不重新获取——直接使用周期创建时保存的数据。**

确认文件存在：

```bash
# 消息面数据
test -f active/${CYCLE_DIR}/data-context/sentiment-media.md && echo "存在" || echo "缺失"

# 链上数据
test -f active/${CYCLE_DIR}/data-context/sentiment-onchain.md && echo "存在" || echo "缺失"
```

| 文件 | 状态 | 处理 |
|------|------|------|
| `sentiment-media.md` | 存在 | 复用，清单标记 `status: "reused"` |
| `sentiment-media.md` | 缺失 | 标记 `status: "missing"`，不影响流程 |
| `sentiment-onchain.md` | 存在 | 复用，清单标记 `status: "reused"` |
| `sentiment-onchain.md` | 缺失 | 标记 `status: "missing"`，不影响流程 |

> 媒体和链上数据是周期级静态快照，即时分析不重跑。阶段二分析时应当注意数据可能不是最新的。

**日志记录：**

```
[$NOW] [即时分析阶段一] 已有数据复用: 媒体={存在/缺失}, 链上={存在/缺失}
```

---

### 步骤 5：收集历史报告路径

**⚠️ 只收集路径，不读取内容。**

```bash
ls -t active/alt-${COIN}-*/reports/alt-report-${COIN}-*.md 2>/dev/null | grep -v "${CYCLE_DIR}" | head -5
```

排除当前周期自身（当前周期目录匹配 `$CYCLE_DIR`）。

**日志记录：**

```
[$NOW] [即时分析阶段一] 历史报告收集: {COIN} 找到 N 篇
```

---

### 步骤 6：输出数据清单 JSON

**保存路径：** `active/${CYCLE_DIR}/data-context/data-manifest-instant-${COIN}-YYYYMMDD-HHMM.json`

**JSON 格式：**

```json
{
  "manifest_version": "1.0",
  "stage": "altcoin-instant",
  "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00",

  "alert_context": {
    "alert_name": "DOGE-price-breakout",
    "alert_time": "YYYY-MM-DDTHH:MM:SS+08:00",
    "alert_type": "price_breakout",
    "trigger_price": 0.15,
    "current_price": 0.152,
    "raw_data": { "...警报collect()返回的完整数据..." }
  },

  "coin": {
    "symbol": "DOGE",
    "cycle_dir": "alt-DOGE-20260503-1200"
  },

  "data_collected": {
    "contract": {
      "status": "success",
      "data_file": "data/DOGE-instant-20260506-1427.json",
      "source": "OKX API (即时获取)",
      "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00"
    },
    "sentiment_media": {
      "file": "alt-DOGE-20260503-1200/data-context/sentiment-media.md",
      "status": "reused",
      "note": "复用周期创建时数据"
    },
    "sentiment_onchain": {
      "file": "alt-DOGE-20260503-1200/data-context/sentiment-onchain.md",
      "status": "reused",
      "note": "复用周期创建时数据"
    }
  },

  "history_reports": {
    "coin": "DOGE",
    "reports": [],
    "total_count": 0
  },

  "next_stage": {
    "task_file": "tasks/alt-intel-stage2.md",
    "spawn_instruction": "阶段一即时数据获取已完成，请读取 data-manifest 开始阶段二交叉验证分析。"
  }
}
```

**日志记录：**

```
[$NOW] [即时分析阶段一] 数据清单已生成: data-manifest-instant-${COIN}-YYYYMMDD-HHMM.json
```

---

### 步骤 7：记录阶段结束

**输出当前进度：**

```
阶段一即时数据获取已完成。
币种: {COIN}
周期: active/{CYCLE_DIR}
数据清单: active/{CYCLE_DIR}/data-context/data-manifest-instant-{COIN}-YYYYMMDD-HHMM.json
请读取 tasks/alt-intel-stage2.md 开始阶段二交叉验证分析。
```

**记录日志：**

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [即时分析阶段一] ========== 阶段一结束 ========== " >> logs/alt-${COIN}-process.log
```

---

## 阶段过渡

输出数据清单路径后，立即读取并执行 `tasks/alt-intel-stage2.md`。

---

## 异常处理

| 异常类型 | 级别 | 处理方式 |
|---------|------|---------|
| 警报 JSON 解析失败 | `⛔ ERROR` | 记录异常，结束本阶段 |
| `coin` 字段缺失 | `⛔ ERROR` | 记录异常，结束本阶段 |
| 未找到活跃周期 | `⛔ ERROR` | 记录异常，结束本阶段 |
| 合约数据脚本执行失败 | `⛔ ERROR` | 清单标记 `status: "failed"`，阶段二仅凭媒体+链上分析 |
| 媒体/链上数据缺失 | `⚠️ WARN` | 标记缺失，继续执行 |
| 历史报告收集为空 | `⚠️ WARN` | 标记无历史，继续执行 |
| 数据清单 JSON 生成失败 | `⛔ ERROR` | 记录异常后结束本阶段 |

---

## 与常规阶段一的区别

| | 常规阶段一 | 即时分析阶段一 |
|---|---|---|
| 触发 | 扫描引擎 | 警报 trigger() |
| 周期 | 检测并创建 | 只定位，不创建 |
| 媒体搜索 | ✅ web_search | ❌ 不复跑 |
| 链上数据 | ✅ onchainOS | ❌ 复用已有 |
| 合约数据 | ✅ get_altcoin_analysis | ✅ 同 |
| 数据清单 | `data-manifest-*.json` | `data-manifest-instant-*.json` |
| 后续阶段 | alt-intel-stage2/3/4 | **共用** alt-intel-stage2/3/4 |

---

## 核心要求

1. **解析警报 JSON**：task 消息中第一个空行前的内容即为 JSON
2. **定位已有周期**：`active/alt-{COIN}-*`，不创建新周期
3. **只获取合约数据**：`get_altcoin_analysis.js --coin {COIN}`
4. **复用媒体/链上**：使用 `data-context/` 下已有文件
5. **清单带 alert_context**：供阶段二理解触发背景
6. **后续阶段共用**：与常规流程使用相同的 alt-intel-stage2/3/4
7. **异常分级记录**：`⚠️ WARN` 不中断，`⛔ ERROR` 视情况处理

---

alt-instant-stage1-v1.0
