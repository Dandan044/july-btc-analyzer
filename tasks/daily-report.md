# 日报任务规则

## 执行步骤

### 0. 检查周期状态

**每次报告前必须先检查交易周期状态！**

```bash
# 检查是否有活跃周期
ls -d active/cycle-* 2>/dev/null
```

**情况A：`active/` 为空**
- 这是新一轮周期的开始
- 在报告保存前创建新周期文件夹
- 命名规则：`cycle-YYYYMMDD-001`（同一天第二个周期用 002，以此类推）
- 创建空的交易建议文件 `trade-suggestions.json`

**情况B：`active/` 有周期文件夹**
- 读取 `active/cycle-*/trade-suggestions.json`
- 了解当前是否有持仓、止盈止损价位
- 报告保存到该周期的 `reports/` 文件夹

---

### 1. 获取历史日报

**必须先读取历史报告，才能进行本次分析！**

**从当前周期的 reports/ 文件夹获取：**
- 如果 `active/` 有周期：从 `active/cycle-*/reports/` 读取
- 如果 `active/` 为空：无需读取（新周期开始）

获取规则：
- 最近 **3 天** 的日报文件
- 最近 **2 天** 的即时分析报告
- 总共最多 **10 篇** 报告

**历史报告用途：**
- 对比价格走势是否符合前次预期
- 验证之前的支撑/压力位是否有效
- 评估当前周期内交易建议的执行结果
- 发现连续的趋势或反转信号

---

### 2. 获取数据

```bash
node skills/btc-market-lite/scripts/get_enhanced_analysis.js --save
```

**注意：** 使用 `--save` 参数会自动保存数据到 `data/YYYY-MM-DD.json`，无需手动保存。

---

### 3. 分析数据并生成报告

**结合历史报告和当前周期状态进行本次分析**，按照下方报告结构撰写。

**如果有持仓中的交易建议：**
- 检查当前价格是否触发止盈/止损
- 在报告中说明当前持仓状态
- 如触发，更新交易建议状态

---

### 4. 周期管理与报告保存

#### 4.1 创建新周期（如果 `active/` 为空）

```bash
# 获取当前日期
DATE=$(date +%Y%m%d)

# 检查今天是否已有周期（防止重复）
EXISTING=$(ls -d active/cycle-${DATE}-* 2>/dev/null | wc -l)

# 创建新周期文件夹
CYCLE_NUM=$(printf "%03d" $((EXISTING + 1)))
mkdir -p active/cycle-${DATE}-${CYCLE_NUM}/reports
```

#### 4.2 创建空交易建议文件

```json
{
  "cycle_id": "cycle-YYYYMMDD-XXX",
  "status": "active",
  "started_at": "YYYY-MM-DDTHH:MM:SS+08:00",
  "closed_at": null,
  "closed_reason": null,
  "suggestions": [],
  "summary": {
    "total": 0,
    "open": 0,
    "closed": 0
  }
}
```

保存到：`active/cycle-*/trade-suggestions.json`

#### 4.3 保存报告文件

报告文件命名规则：
- 格式：`btc-report-YYYY-MM-DD-HHMM.md`
- 示例：`btc-report-2026-03-03-0900.md`
- 时间精确到分钟，使用 24 小时制
- 保存路径：`active/cycle-*/reports/btc-report-YYYY-MM-DD-HHMM.md`

**必须先保存报告文件，再发送到飞书！**

---

### 5. 交易建议管理

#### 5.1 如果报告给出了交易建议

将交易建议追加到 `trade-suggestions.json` 的 `suggestions` 数组中：

```json
{
  "id": "sug-001",
  "created_at": "YYYY-MM-DDTHH:MM:SS+08:00",
  "triggered_by": "report-YYYY-MM-DD-HHMM",
  "direction": "long|short",
  "entry_zone": [下限, 上限],
  "stop_loss": 止损价,
  "take_profit": [止盈1, 止盈2],
  "position_size": "建议仓位描述",
  "status": "open",
  "closed_at": null,
  "close_reason": null,
  "notes": "建议依据说明"
}
```

同时更新 `summary`：
- `total` += 1
- `open` += 1

#### 5.2 如果价格触发止盈/止损

找到对应的建议，更新状态：

```json
{
  "status": "closed",
  "closed_at": "YYYY-MM-DDTHH:MM:SS+08:00",
  "close_reason": "take_profit|stop_loss"
}
```

同时更新 `summary`：
- `open` -= 1
- `closed` += 1

#### 5.3 检查是否需要归档

```bash
# 读取 trade-suggestions.json
# 检查 summary.open 是否为 0 且 summary.total > 0
```

**如果 `summary.open === 0` 且 `summary.total > 0`：**
- 周期结束，执行归档

---

### 6. 归档周期

**触发条件：** `summary.open === 0` 且 `summary.total > 0`

**归档步骤：**

```bash
# 1. 更新 trade-suggestions.json
# 设置 status: "closed"
# 设置 closed_at: 当前时间
# 设置 closed_reason: "all_positions_closed"

# 2. 移动文件夹
mv active/cycle-* archived/
```

**注意：** 归档后，下一篇报告会开启新周期。

---

### 7. 发送报告到飞书

使用 feishu_doc 工具发送报告内容到飞书：
1. 读取刚保存的报告文件
2. 使用 feishu_doc 发送到 Dandan 的私聊

---

### 8. 记录日志（必须执行）

**⚠️ 无论成功或失败，都必须记录日志！**

#### 文件存储规则

| 文件类型 | 路径 | 规则 |
|---------|------|------|
| 原始数据 | `data/YYYY-MM-DD.json` | **自动保存**（脚本 --save 参数） |
| 执行日志 | `logs/btc-reports.log` | **追加**，失败也要记录 |
| 完整报告 | `active/cycle-*/reports/btc-report-YYYY-MM-DD-HHMM.md` | **独立文件** |
| 交易建议 | `active/cycle-*/trade-suggestions.json` | **周期文件** |

#### logs/btc-reports.log 格式（追加模式）

**成功时：**
```
[YYYY-MM-DD HH:mm:ss] 报告已发送 | 价格: $xx,xxx.xx | FGI: xx | 消息ID: om_xxx | 周期: cycle-xxx | 报告文件: btc-report-YYYY-MM-DD-HHMM.md
```

**失败时：**
```
[YYYY-MM-DD HH:mm:ss] 任务失败 | 价格: $xx,xxx.xx | FGI: xx | 错误: 具体错误信息
```

---

## 报告结构

你的报告必须包含以下五个部分，按顺序呈现：

### 一、历史回顾（如有历史报告）

**此部分必须先完成，用于指导后续分析！**

回顾当前周期内的历史报告：
- 上次报告的预期走势是否应验？
- 上次标注的支撑/压力位是否有效？
- 当前周期内的交易建议执行结果如何？
- 还能得出什么结论...

列出参考的报告文件名。

如果没有历史报告（新周期），说明"新周期开始，无历史报告"。


### 二、数据呈现

呈现当前市场的核心数据，让读者快速了解市场状态。用专业的方式展示价格、情绪、技术指标等关键数据。
- 关注数据中的OHLC数据，最高点、最低点是否突破，结合开盘价收盘价是否撤回等，按照时间序列得到走势信息。
- 关于恐慌贪婪指数：其为日级别的更新，因此一日间的恐慌指数保持不变是正常行为，但是依旧能作为跨日级别的判断依据。**注意：不要使用日内恐慌指数不变作为判断依据，因为不变不是因为情绪没有发生改变，而是因为他没有更新**

### 三、价格行为技术分析

这是报告的核心。你需要回答：

- **为什么会这样？** 近期价格走势背后的驱动因素是什么？
- **是什么导致的？** 哪些数据指标解释了当前的市场状态？
- **未来可能发生哪些走向？** 基于数据，你认为市场可能的几种演变路径？
- **各走向的概率？** 给出你的概率评估，并说明依据。

用连贯的专业分析文字，引用具体数据来支撑你的判断。不要用分点罗列，而是写成完整的分析段落。

### 四、行情推断

- **关键位置：** 哪些价格位置是关键支撑/压力？为什么？
- **值得关注的行为：** 后续价格出现什么行为需要特别关注？例如回踩、突破、震荡？这些行为意味着什么？

### 五、交易建议

**如果有持仓中的建议：**
- 先说明当前持仓状态（入场价、止损、止盈、当前盈亏）
- 检查是否触发止盈/止损
- 如触发，说明执行结果

**新建议表格：**
- 不要纠结已完成的交易，尽快根据新的市场变化给出新的交易建议
- 多空变换灵活，不止是单方向的做，若市场转向，尝试快速变换交易风格、交易方向
- 如果当前周期已有未关闭的建议，谨慎给出新建议

| 项目 | 内容 |
|------|------|
| 方向 | 做多/做空/观望 |
| 入场位置 | $xxx |
| 仓位 | xx% (计算杠杆后50%~300%)|
| 止损 | $xxx (-xx%) |
| 止盈1 | $xxx (+xx%，平仓xx%) |
| 止盈2 | $xxx (+xx%，平仓剩余) |
| 盈亏比 | 1:xx |
| 风险 | 高/中/低（可支撑的依据越多，风险等级越低。） |

在表格下方，简要说明这个建议与你分析的关联——为什么给出这个建议？

---

## 核心要求

1. **必须先检查周期状态**：报告前检查 `active/` 是否有周期
2. **必须先读历史报告**：分析前必须获取并回顾当前周期的历史报告
3. 数据说什么，你就说什么
4. 分析要有逻辑，引用具体数据支撑判断
5. 交易建议必须具体，有明确的入场、止损、止盈价格
6. **必须完成以下步骤**：
   - 周期管理 → 创建新周期或读取现有周期
   - 报告文件 → `active/cycle-*/reports/btc-report-YYYY-MM-DD-HHMM.md`
   - 交易建议 → 更新 `trade-suggestions.json`
   - 归档检查 → 如所有建议关闭，执行归档
   - 发送记录 → `logs/btc-reports.log`
   - 发送报告到飞书私聊
   - 执行警报器管理任务

⚠️ 报告末尾注明：仅供参考，不构成投资建议。七月-v3.14。

---

### 9. 警报器管理

**日报任务完成后，立即执行警报器管理任务！**

阅读 `tasks/alert-management.md`，按照其中的步骤管理警报器规则。