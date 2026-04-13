# 即时分析任务规则

当收到"即时分析"指令或警报触发数据时，按以下流程执行。

---

## ⚡ SPAWN 触发机制

**如果消息以 `[SPAWN_INSTANT_ANALYSIS]` 开头：**

这表示警报器触发的即时分析请求。为了避免上下文干扰，**必须立即 spawn 新会话执行**：

```
使用 sessions_spawn 工具：
- agentId: "july"
- mode: "run"  
- timeoutSeconds: 0 （不等待完成）
- task: 移除 `[SPAWN_INSTANT_ANALYSIS]` 前缀后的完整内容
```

**执行后立即返回**，不要等待子会话完成。子会话会独立执行下面的即时分析流程。

---

## 触发来源

此任务由警报器系统触发，警报返回中携带本次分析所需的市场数据：

```javascript
// 警报 trigger() 传递的数据结构示例
{
  alertName: '警报名称',
  triggerTime: '2026-03-05T11:30:00.000Z',
  alertType: 'breakthrough' | 'breakdown' | 'volume_spike' | ...,
  // ... 警报 collect() 收集的数据
  klines: [...],
  volume24h: ...,
  message: '触发原因描述'
}
```

**⚠️ 重要：每次即时分析任务触发时，必须调用专用数据获取方法，获取完整的短期市场数据。**

---

## 执行步骤

### 0. 检查周期状态

**每次报告前必须先检查交易周期状态！**

```bash
# 检查是否有活跃周期
ls -d active/cycle-* 2>/dev/null
```

**情况A：`active/` 为空**
- 上一周期刚结束或首次运行
- 创建新周期文件夹
- 命名规则：`cycle-YYYYMMDD-001`
- 创建空的交易建议文件

**情况B：`active/` 有周期文件夹**
- 读取 `active/cycle-*/trade-suggestions.json`
- 了解当前持仓状态

---

### 1. 解析警报数据

从任务指令中提取：
- **警报名称** - 识别是哪个警报触发
- **触发时间** - 精确到秒
- **警报类型** - breakthrough / breakdown / volume_spike / ...
- **市场数据** - K线、价格、交易量等

---

### 2. 获取即时分析数据（必须执行）

**⚠️ 每次即时分析任务都必须执行此步骤！**

调用专用数据获取方法：

```bash
node skills/btc-market-lite/scripts/get_instant_data.js --save
```

**数据内容：**
- **12根4小时K线** - 约2天数据，覆盖中期趋势
- **4根1小时K线** - 4小时数据，捕捉短期变化
- **8根15分钟K线** - 2小时数据，捕捉即时细节
- **24小时ticker** - 当前价格、涨跌、最高最低、成交量
- **交易侧数据** - 资金费率、OI、多空比、Taker买卖比（每个时间粒度都有）

**数据保存：**
- 自动保存到 `data/instant-YYYY-MM-DD-HH-MM-SS.json`
- 使用时间戳命名，不会覆盖历史数据

---

### 3. 获取历史报告（24小时内）

**⛔ 禁止读取 `archived/` 文件夹。新周期从头开始，不受归档数据影响。**

**从当前周期的 reports/ 文件夹获取：**
- 路径：`active/cycle-*/reports/`
- **时间范围**：当前时间往前推 24 小时
- **报告类型**：所有报告（包括 `btc-report-*` 和 `instant-report-*`）
- **数量限制**：最多 20 篇

**历史报告用途：**
- 回顾24小时内价格走势
- 验证之前标注的支撑/压力位
- 评估市场情绪变化
- 发现连续趋势或反转信号

---

### 4. 分析数据并撰写报告

#### 评估是否需要补充数据

警报提供了触发时刻的市场快照。根据分析需要，判断是否需要：

- 更小时间粒度（捕捉短期细节）
- 更长时间跨度（判断大趋势）
- 特定指标的历史数据（验证假设）

**如果需要补充数据，直接调用 API 获取，不要局限于固定脚本。**

**可用 API 参考：**

| 脚本 | 方法 | 数据 | 说明 |
|------|------|------|------|
| `get_instant_data.js` | 即时分析数据 | 4h/1h/15m K线 + ticker + 交易侧数据 | **即时分析专用**，每次触发必须调用 |
| `scripts/api.js` | `getKlines(symbol, interval, limit)` | K线数据 | CryptoCompare，支持 1m/5m/15m/1h/4h/1d，无需代理 |
| `scripts/api.js` | `getPriceHistory(symbol, days)` | 日线历史 | CryptoCompare，指定天数，用于长趋势 |
| `scripts/api.js` | `getTicker(symbol)` | 实时价格 | CryptoCompare，价格、1h/24h/7d变化 |
| `scripts/api.js` | `getFearGreedIndex(days)` | 恐惧贪婪指数 | alternative.me，历史数据 |
| `get_instant_data.js` | OKX CLI/API | K线+交易侧数据 | 需代理，OI、多空比、Taker比等 |

---

结合警报数据和24小时历史报告，撰写即时分析报告。

**分析重点：**
- 为什么会触发这个警报？
- 当前价格行为验证了什么？
- 与历史报告中预期的是否一致？
- 近期可能的市场走向？

---

### 5. 保存报告

**5.1 保存报告到当前周期的 reports/ 文件夹**

文件命名规则：
- 格式：`instant-report-YYYY-MM-DD-HHMM.md`
- 示例：`instant-report-2026-03-05-1130.md`
- 时间精确到分钟，使用 24 小时制
- 使用警报触发时间（不是当前时间）
- 保存路径：`active/cycle-*/reports/instant-report-YYYY-MM-DD-HHMM.md`

**必须先保存报告文件，再发送到飞书！**

---

### 6. 检查交易建议触发

**如果当前周期有持仓中的建议：**

读取 `trade-suggestions.json`，根据建议状态执行不同操作：

#### 6.1 ⭐ 检查 pending_entry 状态的建议（入场确认）

对于 `status: "pending_entry"` 的建议，检查是否满足入场条件：

**判断逻辑：**
1. 检查当前价格是否在 `entry_zone` 范围内
2. 检查是否满足 `entry_condition` 中设定的触发条件
3. 如果满足，确认入场，更新状态：
   ```json
   {
     "status": "open",
     "entry_actual": 当前价格,
     "entry_at": "YYYY-MM-DDTHH:MM:SS+08:00",
     "entry_confirmed_by": "instant-report-YYYY-MM-DD-HHMM"
   }
   ```

**入场条件判断示例：**

| 入场条件类型 | 判断方式 |
|-------------|---------|
| 到达$xxx立即入场 | 当前价格在 entry_zone 范围内 |
| 突破$xxx确认后入场 | 价格已突破 trigger_price 且当前仍在 entry_zone 内 |
| N小时后检查入场 | 检查当前价格是否在 entry_zone 范围内 |
| 量能放大后入场 | 检查交易量数据是否满足 trigger_criteria |

**⚠️ 注意：** 只有满足入场条件才更新状态为 `open`。如果不满足条件，保持 `pending_entry` 状态，等待下次检查。

#### 6.2 检查 open 状态的建议（止盈/止损触发）

对于 `status: "open"` 的建议，检查警报触发的价位是否命中任何止盈/止损：

- 如触发止盈/止损，更新建议状态：
  ```json
  {
    "status": "closed",
    "closed_at": "YYYY-MM-DDTHH:MM:SS+08:00",
    "close_reason": "take_profit|stop_loss"
  }
  ```
- 更新 `summary`（open -= 1, closed += 1）
- 检查是否需要归档（open === 0 且 total > 0）

#### 6.3 ⭐ 如果即时分析给出新交易建议（必须执行）

即时分析任务也可能给出新的交易建议（周期内无建议时，或市场出现新机会时）。

**如果给出新建议，必须执行以下流程：**

**1. 写入交易建议到 `trade-suggestions.json`：**

使用与日报任务相同的建议结构（参考 `tasks/daily-report.md` 第5.2节）：

```json
{
  "id": "sug-xxx",
  "created_at": "YYYY-MM-DDTHH:MM:SS+08:00",
  "triggered_by": "instant-report-YYYY-MM-DD-HHMM",
  "direction": "long|short",
  "entry_zone": [下限, 上限],
  
  // ⭐ 入场条件（必须填写）
  "entry_condition": {
    "type": "immediate | delayed | conditional",
    "description": "具体入场条件描述",
    "trigger_price": null,
    "trigger_criteria": null,
    "delay_hours": null
  },
  
  // ⭐ 警报配置（非立即入场时必须填写）
  "alert_config": {
    "should_create": true,
    "alert_type": "price | timer | conditional",
    "alert_name": null,
    "alert_file": null
  },
  
  "stop_loss": 止损价,
  "take_profit": [止盈1, 止盈2],
  "position_size": "建议仓位描述",
  "status": "pending_entry | open",
  "closed_at": null,
  "close_reason": null,
  "notes": "建议依据说明"
}
```

**2. 判断初始状态：**
- `entry_condition.type === "immediate"` → `status: "open"`（立即入场）
- `entry_condition.type !== "immediate"` → `status: "pending_entry"`（等待入场）

**3. ⭐ 若非立即入场，必须创建警报：**

如果 `entry_condition.type !== "immediate"`，必须执行：
1. 阅读 `tasks/set-alert.md` 了解警报创建方法
2. 根据入场条件创建对应类型的警报：
   - **价格触发** → 创建价格警报
   - **定时触发** → 创建定时器警报
   - **条件触发** → 创建延迟触发警报或条件警报
3. 将警报信息写入 `alert_config` 字段

**4. 更新 `summary`：**
- `total` += 1
- `open` += 1

---

### 7. ⭐ 仓位执行检查（必须执行）

**无论本次即时分析是否确认入场或给出交易建议，都必须路由到仓位执行任务！**

阅读 `tasks/execute-trade.md`，按照其中的步骤执行：
1. 检查周期状态
2. 读取交易建议文件
3. 根据建议状态执行相应操作：
   - `status: "open"` 且 `entry_actual === null` → 执行开仓
   - `status: "open"` 且 `entry_actual !== null` → 记录"已开仓"日志
   - `status: "pending_entry"` → 记录"等待入场，条件未满足"日志
   - `status: "closed"` → 记录"已平仓"日志
   - 无建议或观望 → 记录"无待执行建议"日志
4. 记录日志到 `logs/trade-execution.log`

**安全限制（开仓时）：**
- 杠杆固定为 3x，不更改
- 使用逐仓模式（isolated）
- 必须创建止盈止损
- 止损覆盖全部仓位
- 两档止盈合计覆盖全部仓位

---

### 8. 归档检查

⚠️ **归档前必须核对：** 确认 `trade-suggestions.json` 中每个建议的止盈/止损价格是否真的被触发。**最低价 ≤ 止盈价** 才算触发止盈，**最高价 ≥ 止损价** 才算触发止损。切勿混淆"支撑/阻力跌破"与"止盈止损触发"。

**如果 `summary.open === 0` 且 `summary.total > 0`：**

```bash
# 1. 更新 trade-suggestions.json
# status: "closed"
# closed_at: 当前时间
# closed_reason: "all_positions_closed"

# 2. 移动文件夹
mv active/cycle-* archived/
```

---

### 9. 发送到飞书

使用 feishu_doc 工具发送报告内容到飞书：
1. 读取刚保存的报告文件
2. 使用 feishu_doc 发送到 Dandan 的私聊

---

### 10. 记录日志

**无论成功或失败，都必须记录日志！**

日志文件：`logs/instant-reports.log`

格式：
```
[YYYY-MM-DD HH:mm:ss] 即时报告已发送 | 警报: xxx | 触发时间: xxx | 周期: cycle-xxx | 消息ID: om_xxx | 报告文件: instant-report-xxx.md
```

失败时：
```
[YYYY-MM-DD HH:mm:ss] 即时分析失败 | 警报: xxx | 错误: 具体错误信息
```

---

### 11. 警报器管理

**即时分析任务完成后，立即执行警报器管理任务！**

阅读 `tasks/alert-management.md`，按照其中的步骤管理警报器规则。

---

## 报告结构

即时分析报告必须包含以下部分：

### 一、警报概要

简要说明警报触发情况：
- 警报名称
- 触发时间
- 触发原因（价格/指标变化）
- 当前价格

### 二、24小时行情回顾

回顾24小时内当前周期的报告内容：
- 价格走势是否符合预期
- 支撑/压力位是否有效
- 市场情绪变化

列出参考的报告文件名。

### 三、即时分析

#### 趋势联动分析

**对于指标和价格不要只看最新值，要看历史走势。**

**不要孤立分析，要看指标间关系。**

市场状态由多个指标共同决定。思考：
- 哪些指标在相互验证？哪些在背离？
- 价格变动背后，其他指标说明了什么？
- 哪些趋势组合能揭示当前市场本质？

在分析中体现你对趋势和联动的思考过程，而非罗列孤立数值。

针对警报触发原因进行深入分析：

- **触发原因分析**：为什么会在此时触发？市场发生了什么变化？
- **技术指标解读**：当前技术指标说明什么？
- **关键位置验证**：警报监控的关键位置是否有效？
- **可能的后续走势**：基于数据判断的几种可能性

### 四、持仓状态（如有）

**如果当前周期有持仓中的建议：**
- 说明当前持仓的入场价、止损、止盈
- 检查本次价格变动是否触发止盈/止损
- 如触发，说明执行结果

### 五、操作建议（如有）

1. 当前是否存在利多条件？为什么？哪些数据支撑？
2. 当前是否存在利空条件？为什么？哪些数据支撑？
3. 哪个方向更明确？

**决策原则：**
- 利多条件更明确 → 做多
- 利空条件更明确 → 做空
- 两者都不明确 → 观望


一切基于数据，不预设方向偏好。

**新建议表格：**
- 多空变换灵活，你不应该只做空或只做多，快速变换交易风格、交易方向
- 如果当前周期已有未关闭的建议，谨慎给出新建议
- 若给出新建议,记得要更新当前周期文件夹内的建议文件
- ⭐ **入场条件必须明确**：说明何时入场、触发条件、是否需要创建警报

| 项目 | 内容 |
|------|------|
| 方向 | 做多/做空/观望 |
| 入场位置 | $xxx |
| 入场条件 | 立即入场 / 到达$xxx立即入场 / 突破$xxx确认后入场 / N小时后检查入场 |
| 仓位 | xx% (50%~300%)|
| 止损 | $xxx (-xx%) |
| 止盈1 | $xxx (+xx%，平仓xx%) |
| 止盈2 | $xxx (+xx%，平仓剩余) |
| 盈亏比 | 1:xx |
| 风险 | 高/中/低（依据越多，风险等级越低。） |

**入场条件填写说明：**
- **立即入场**：当前市场条件满足，建议直接入场
- **到达$xxx立即入场**：价格触及目标位后立即入场（需要创建价格警报）
- **突破$xxx确认后入场**：突破后等待确认（需要创建延迟触发警报）
- **N小时后检查入场**：定时检查（需要创建定时器警报）

在表格下方，简要说明这个建议与你分析的关联——为什么给出这个建议？为什么设定这个入场条件？

### 六、仓位执行检查

**⚠️ 此部分必须执行，详见 `tasks/execute-trade.md`**

根据当前交易建议状态执行仓位操作：

| 建议状态 | 执行动作 |
|---------|---------|
| `status: "open"` 且 `entry_actual === null` | 执行开仓，创建止盈止损 |
| `status: "open"` 且 `entry_actual !== null` | 记录"已开仓，无需操作" |
| `status: "pending_entry"` | 记录"等待入场，条件未满足" |
| `status: "closed"` | 记录"已平仓" |
| 无建议或观望 | 记录"无待执行建议" |

**安全限制：杠杆固定3x，逐仓模式，止盈止损必须覆盖全部仓位。**

### 七、警报变更

简述本次警报器管理的规划：
- 准备新增哪些警报谷子额
- 准备删除/归档了哪些警报规则
- 执行完警报器管理之后会生效的警报类型和数量
（在报告撰写完毕后进行以上的警报器规划执行）

### 八、补充数据

说明本次分析获取的数据：
- **默认数据**：12根4hK线 + 4根1hK线 + 8根15mK线 + 24h ticker + 交易侧数据（由 `get_instant_data.js` 获取）
- **额外数据**：如有额外获取（如日线历史、恐惧贪婪指数等），列出获取内容

---

⚠️ 报告末尾注明：仅供参考，不构成投资建议。七月v4.12。