# 即时分析任务 - 阶段一：数据获取

此任务为即时分析工作流的第一阶段，负责解析警报数据、补全市场数据、同步实盘持仓。

---

## 触发方式

由警报器触发，主会话收到 `[SPAWN_INSTANT_ANALYSIS]{...alertData...}` 消息后，spawn 隔离会话执行本任务。

也可不由警报器触发，若不由警报器触发，未获取警报器返回内容，则后续警报器数据设为空即可。
---

## 日志文件

**即时分析各阶段共用日报日志文件：**

路径：`logs/daily-report-process.log`

格式：追加模式，记录每个阶段的开始、结束、警告、错误。

### 日志标识规则

| 级别 | 标识 | 含义 |
|------|------|------|
| 警告 | `⚠️ WARN` | 不影响流程继续，但需关注 |
| 错误 | `⛔ ERROR` | 可能影响后续阶段，需人工介入 |

**日志格式：**

```
正常: [时间] [即时分析阶段一] 内容
警告: [时间] [即时分析阶段一] ⚠️ WARN: 内容
错误: [时间] [即时分析阶段一] ⛔ ERROR: 内容
```

---

## 执行步骤

### 1. 记录阶段开始

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] ========== 即时分析流程启动 ==========" >> logs/daily-report-process.log
echo "[$NOW] [即时分析阶段一] 开始执行" >> logs/daily-report-process.log
```

---

### 2. 检查周期状态并创建文件夹

```bash
ls -d active/cycle-* 2>/dev/null
```

**情况A：`active/` 为空**
- 创建新周期：`cycle-YYYYMMDD-001`
- 创建子文件夹：`reports/`、`data-context/`

```bash
DATE=$(date +%Y%m%d)
EXISTING=$(ls -d active/cycle-${DATE}-* 2>/dev/null | wc -l)
CYCLE_NUM=$(printf "%03d" $((EXISTING + 1)))

mkdir -p active/cycle-${DATE}-${CYCLE_NUM}/reports
mkdir -p active/cycle-${DATE}-${CYCLE_NUM}/data-context
```

**情况B：`active/` 有周期文件夹**
- 确认 `data-context/` 子文件夹存在

**日志记录：**
```
[$NOW] [即时分析阶段一] 周期状态: cycle-YYYYMMDD-XXX (新建/已存在)
```

---

### 3. 解析警报数据

阶段一收到的 task 内容即为纯 JSON 警报数据对象（主会话已移除前缀）。

**解析步骤：**
1. JSON.parse 得到警报数据对象
2. 提取关键字段：
   - `alertName` - 警报名称
   - `alertTime` - 触发时间
   - `currentPrice` - 当前价格
   - `alertType` - 警报类型
   - `triggerPrice` - 触发价位
   - 其他警报携带的字段（klines、openInterest 等）

**日志记录：**
```
[$NOW] [即时分析阶段一] 警报数据解析: alertName=xxx, alertTime=xxx, alertType=xxx
```

---

### 4. 同步实盘持仓

**任务路由：** 读取 `tasks/sync-positions.md` 执行持仓同步任务。

**输入参数：**
- 周期文件夹路径：当前活跃周期
- 日志文件路径：`logs/daily-report-process.log`

**输出产物：**
- 持仓文件：`active/cycle-*/positions.json`

---

### 5. 获取即时市场数据

```bash
node skills/btc-market-lite/scripts/get_instant_data.js --save
```

数据保存到 `data/instant-YYYY-MM-DD-HH-MM-SS.json`。

**注意：** 警报 collect() 已携带部分数据（klines、openInterest 等），此步骤补充获取完整的市场数据（多空比、Taker买卖比、恐惧贪婪等）。

**执行结果判断：**

| 结果 | 日志记录 | 清单标记 |
|------|---------|---------|
| 成功 | `[即时分析阶段一] 市场数据获取: 成功` | `status: "success"` |
| 失败 | `[即时分析阶段一] ⛔ ERROR: 市场数据脚本执行失败` | `status: "failed"` |

---

### 6. 收集历史报告路径

**⚠️ 只收集路径，不读取内容。**

从当前周期的 `reports/` 文件夹：

- 最近 **3 天** 的日报文件（btc-report-*.md）
- 最近 **2 天** 的即时分析报告（instant-report-*.md）
- 总共最多 **10 篇**

```bash
# 列出日报文件
ls -t active/cycle-*/reports/btc-report-*.md 2>/dev/null | head -10

# 列出即时分析报告
ls -t active/cycle-*/reports/instant-report-*.md 2>/dev/null | head -5
```

**如果没有历史报告（新周期）：** 标记 `note: "新周期开始，无历史报告"`。

**日志记录：**
```
[$NOW] [即时分析阶段一] 历史报告路径收集: X 篇 (日报 Y 篇, 即时分析 Z 篇)
```

---

### 7. 输出数据清单 JSON

**保存路径：** `active/cycle-*/data-context/data-manifest-instant-YYYY-MM-DD-HHMM.json`

**命名规则：** 使用警报触发时间。

**JSON 格式规范：**

```json
{
  "manifest_version": "1.0",
  "stage": "data-collection",
  "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00",

  "alert_context": {
    "alert_name": "警报名称",
    "alert_time": "YYYY-MM-DDTHH:MM:SS+08:00",
    "alert_type": "breakthrough|breakdown|volume_spike|...",
    "trigger_price": 73666,
    "current_price": 73666
  },

  "cycle": {
    "id": "cycle-YYYYMMDD-XXX",
    "status": "active",
    "started_at": "YYYY-MM-DDTHH:MM:SS+08:00",
    "positions_file": "active/cycle-YYYYMMDD-XXX/positions.json",
    "is_new_cycle": true
  },

  "持仓信息": {
    "文件": "active/cycle-YYYYMMDD-XXX/positions.json",
    "同步时间": "YYYY-MM-DDTHH:MM:SS+08:00",
    "当前持仓数": 0,
    "有BTC逐仓持仓": false,
    "数据来源": "OKX实盘账户"
  },

  "data_files": {
    "market_data": {
      "path": "data/instant-YYYY-MM-DD-HH-MM-SS.json",
      "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00",
      "source": "OKX + CryptoCompare + alternative.me",
      "status": "success"
    }
  },

  "history_reports": {
    "daily_reports": [
      {
        "path": "active/cycle-xxx/reports/btc-report-YYYY-MM-DD-HHMM.md",
        "date": "YYYY-MM-DD",
        "type": "daily"
      }
    ],
    "instant_reports": [
      {
        "path": "active/cycle-xxx/reports/instant-report-YYYY-MM-DD-HHMM.md",
        "date": "YYYY-MM-DD",
        "type": "instant"
      }
    ],
    "total_count": 0,
    "note": "新周期开始，无历史报告"
  },

  "next_stage": {
    "task_file": "tasks/daily-report-stage2.md",
    "spawn_instruction": "阶段一已完成，请读取 data-manifest 开始阶段二分析"
  }
}
```

**注意：**
- 没有 `data_mining_report` 字段（即时分析不生成数据挖掘报告）
- `market_data.path` 指向 `data/instant-*.json`（而非日报的 `data/YYYY-MM-DD.json`）
- `alert_context` 携带警报上下文，供阶段二分析使用

**日志记录：**
```
[$NOW] [即时分析阶段一] 数据清单已生成: data-context/data-manifest-instant-YYYY-MM-DD-HHMM.json
```

---

### 8. Spawn 阶段二

**构建 Spawn 消息：**

```
阶段一数据获取已完成。
数据清单: active/cycle-YYYYMMDD-XXX/data-context/data-manifest-instant-YYYY-MM-DD-HHMM.json
请读取 tasks/daily-report-stage2.md 开始阶段二分析。
```

**Spawn 参数：**

```
sessions_spawn:
- agentId: "july"
- mode: "run"
- timeoutSeconds: 0
- task: [上述消息]
```

**执行后立即返回**，不等待阶段二完成。

---

### 9. 记录阶段结束

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [即时分析阶段一] 完成执行，已 spawn 阶段二" >> logs/daily-report-process.log
echo "[$NOW] [即时分析阶段一] ========== 阶段一结束 ==========" >> logs/daily-report-process.log
```

---

## 异常处理

| 异常类型 | 级别 | 处理方式 |
|---------|------|---------|
| 警报数据解析失败 | `⛔ ERROR` | 记录异常后结束本阶段 |
| 数据脚本执行失败 | `⛔ ERROR` | 清单标记 `status: "failed"`，继续执行 |
| 周期文件夹创建失败 | `⛔ ERROR` | 记录异常，尝试继续执行 |
| 历史报告路径收集失败 | `⚠️ WARN` | 标记 note，继续执行 |
| 数据清单 JSON 生成失败 | `⛔ ERROR` | 记录异常后结束 |
| Spawn 阶段二失败 | `⛔ ERROR` | 记录异常后结束 |

---

## 核心要求

1. **首先记录阶段开始**：日志优先
2. **解析警报 JSON**：收到的 task 内容即为纯 JSON，直接 parse
3. **同步实盘持仓**：从 OKX 实盘获取并覆写
4. **获取即时市场数据**：使用 get_instant_data.js
5. **不生成数据挖掘报告**：跳过此步骤
6. **收集历史报告路径**：与日报阶段一规则一致
7. **manifest 兼容日报阶段二**：格式一致，字段兼容
8. **Spawn 到日报阶段二**：复用餐段二分析逻辑
9. **最后记录阶段结束**

---

## Spawn 消息规范

```
阶段一数据获取已完成。
数据清单: active/cycle-xxx/data-context/data-manifest-instant-xxx.json
请读取 tasks/daily-report-stage2.md 开始阶段二分析。
```

---

即时分析阶段一-v1.1