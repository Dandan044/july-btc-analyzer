# 日报任务 - 阶段一：数据获取

此任务为日报工作流的第一阶段，负责周期检测、数据采集和初步挖掘。

---

## 触发方式

- 由定时任务触发（每天 9:00 和 21:00 GMT+8）
- 或由主会话路由调用

---

## 日志文件

**所有阶段共用同一个日报进程日志文件：**

路径：`logs/daily-report-process.log`

格式：追加模式，记录每个阶段的开始、结束、警告、错误。

### 日志异常标识规则

**使用特殊标识区分警告和错误：**

| 级别 | 标识 | 含义 | 示例 |
|------|------|------|------|
| **警告** | `⚠️ WARN` | 不影响流程继续执行，但需关注 | 数据获取延迟、历史报告数量不足 |
| **错误** | `⛔ ERROR` | 可能影响后续阶段，需人工介入 | 数据脚本执行失败、文件创建失败、spawn 失败 |

**区分原则：**

| 场景 | 级别 | 原因 |
|------|------|------|
| 数据脚本返回但部分字段缺失 | `⚠️ WARN` | 数据仍可用，阶段二可判断 |
| 数据脚本执行超时/失败 | `⛔ ERROR` | 无数据无法进行阶段二分析 |
| 周期文件夹创建失败 | `⛔ ERROR` | 无法保存后续文件 |
| 历史报告数量不足（< 预期） | `⚠️ WARN` | 不影响流程，阶段二自行处理 |
| 历史报告路径收集失败 | `⚠️ WARN` | 可标记无历史，继续执行 |
| 数据挖掘报告生成失败 | `⚠️ WARN` | 清单中标记缺失，阶段二可直接分析原始数据 |
| 数据清单 JSON 生成失败 | `⛔ ERROR` | 阶段二无法获知文件路径 |
| spawn 阶段二失败 | `⛔ ERROR` | 流程中断，需人工重启 |

**日志格式：**

```
正常: [时间] [阶段X] 内容
警告: [时间] [阶段X] ⚠️ WARN: 内容
错误: [时间] [阶段X] ⛔ ERROR: 内容
```

---

## 执行步骤

### 1. 记录阶段开始

**首先在日志中记录本阶段开始：**

```bash
# 获取当前时间
NOW=$(date '+%Y-%m-%d %H:%M:%S')

# 记录阶段开始
echo "[$NOW] ========== 日报流程启动 ========== " >> logs/daily-report-process.log
echo "[$NOW] [阶段一] 开始执行" >> logs/daily-report-process.log
```

---

### 2. 检查周期状态并创建文件夹

**只负责检测和创建，不读取交易建议内容。**

```bash
# 检查是否有活跃周期
ls -d active/cycle-* 2>/dev/null
```

**情况A：`active/` 为空**
- 创建新周期文件夹：`cycle-YYYYMMDD-001`
- 创建子文件夹结构：
  - `reports/`（存放日报和即时分析）
  - `data-context/`（存放数据清单和挖掘报告）
- 创建空的交易建议文件 `trade-suggestions.json`

```bash
DATE=$(date +%Y%m%d)
EXISTING=$(ls -d active/cycle-${DATE}-* 2>/dev/null | wc -l)
CYCLE_NUM=$(printf "%03d" $((EXISTING + 1)))

mkdir -p active/cycle-${DATE}-${CYCLE_NUM}/reports
mkdir -p active/cycle-${DATE}-${CYCLE_NUM}/data-context
```

**情况B：`active/` 有周期文件夹**
- 记录周期 ID
- 确认 `data-context/` 子文件夹存在（不存在则创建）
- **不读取交易建议，不判断持仓，不处理归档**

**日志记录：**
```
[$NOW] [阶段一] 周期状态: cycle-YYYYMMDD-XXX (新建/已存在)
```

---

### 3. 收集历史报告路径

**⚠️ 只收集路径，不读取内容。阶段二自行读取。**

从当前周期的 `reports/` 文件夹列出文件：
- 日报文件（btc-report-*.md）
- 即时分析报告（instant-report-*.md）

**收集规则：**
- 最近 **3 天** 的日报文件（按文件名日期筛选）
- 最近 **2 天** 的即时分析报告
- 总共最多 **10 篇**

**路径收集方式（仅列出文件名）：**

```bash
# 列出日报文件
ls -t active/cycle-*/reports/btc-report-*.md 2>/dev/null | head -10

# 列出即时分析报告
ls -t active/cycle-*/reports/instant-report-*.md 2>/dev/null | head -5
```

**如果没有历史报告（新周期）：** 标记 `note: "新周期开始，无历史报告"`。

**日志记录：**
```
[$NOW] [阶段一] 历史报告路径收集: X 篇 (日报 Y 篇, 即时分析 Z 篇)
```

---

### 4. 获取市场数据

```bash
node skills/btc-market-lite/scripts/get_enhanced_analysis.js --save
```

数据自动保存到 `data/YYYY-MM-DD.json`。

**执行结果判断：**

| 结果 | 日志记录 | 清单标记 |
|------|---------|---------|
| 成功 | `[阶段一] 市场数据获取: 成功` | `status: "success"` |
| 失败 | `[阶段一] ⛔ ERROR: 市场数据脚本执行失败` | `status: "failed"` |
| 部分字段缺失 | `[阶段一] ⚠️ WARN: 数据部分字段缺失: [字段名]` | `status: "partial"` |

---

### 5. 生成数据挖掘报告

**此步骤产出数据事实挖掘成果，供阶段二分析师参考。**

---

#### 5.0 角色定位

**你现在是一名加密货币市场的数据分析师，擅长从繁杂的市场数据中挖掘事实、发现关联、标注异常。**

**你的职责边界：**
- 只陈述事实、归纳现象、发现数据特征
- **不做主观判断、不给交易建议、不预测未来走势**
- 让数据说话，让后续分析师做决策

---

#### 5.1 报告格式

**保存路径：** `active/cycle-*/data-context/data-mining-YYYY-MM-DD-HHMM.md`

**命名规则：** 时间精确到分钟，使用触发时间。

**报告结构（灵活，不固化）：**

```
# 数据挖掘报告 - YYYY-MM-DD HH:MM

## 一、数据概况
[数据源状态、完整性、时间覆盖范围]

## 二、时间序列观察
[由远及近，由大颗粒到小颗粒的数据变化轨迹]

## 三、数据亮点发现
[本次数据中值得关注的特征，动态挖掘，不预设框架]

## 四、指标联动观察
[不同数据维度间的相互关系、验证或分歧]

## 五、异常标注
[偏离常态、值得后续分析关注的数据点]

```

---

#### 5.2 挖掘原则

**时间维度：由远及近，由大到小**

观察数据时，遵循时间递进逻辑：
- 先看长期趋势（30日、14日变化轨迹）
- 再看中期态势（7日、周度特征）
- 最后聚焦近期动态（日内、小时级变化）
- 关注不同时间颗粒度之间的演变关系


---

**颗粒维度：由宏观到微观**

先把握整体态势，再聚焦局部特征：
- 整体 → 局部
- 整体 → 特定
- 全局 → 分时

---

**联动维度：发现数据间的关联**

不孤立看待单个指标，而是寻找数据间的相互关系：
- 价格变动时，哪些同步变化？
- 哪些指标提前于价格出现信号？
- 不同指标是否指向同一方向？
- 指标之间是否相互验证或存在分歧？

**陈述联动，不判断因果。**

---

#### 5.3 挖掘要求

**只陈述事实，不诱导判断：**

| 错误示例 |
|---------|
| "暗示反弹机会" |
| "看空信号" |
| "建议做多" |
| "确认突破有效" |

**动态挖掘，不固化框架：**

根据数据本身呈现的特征，动态决定关注哪些亮点：
- 如果本次数据中出现异常波动 → 聚焦波动特征
- 如果本次数据走势平稳 → 关注平稳中的细微变化
- 如果某个指标出现极值 → 标注极值位置
- 如果数据整体平淡 → 陈述平淡状态本身也是一种发现

以上也只是例子，不要让他们束缚你。
**让数据引导你，而非规则限制你。**

---

#### 5.4 重点关注方向（动态参考）

以下方向供参考，但不强制全部覆盖，视数据实际情况决定：

- **趋势演变**：
- **位置关系**：
- **偏离程度**：
- **联动现象**：
- **连续现象**：
- **断点现象**：
- **极值标注**：

---

#### 5.5 数据质量与局限说明

**如实说明本次数据的实际情况：**

- 数据源是否全部正常返回？
- 是否有字段缺失或时效性问题？
- 数据覆盖的时间范围是否完整？
- 是否存在采样偏差或数据滞后？

**让后续分析师了解数据可信度，自行决定分析策略。**

---

**日志记录：**
```
[$NOW] [阶段一] 数据挖掘报告已生成: data-context/data-mining-YYYY-MM-DD-HHMM.md
```

---

### 6. 输出数据清单 JSON

**生成固定格式的 JSON 文件，供阶段二读取。**

**保存路径：** `active/cycle-*/data-context/data-manifest-YYYY-MM-DD-HHMM.json`

**命名规则：** 与数据挖掘报告时间同步。

**JSON 格式规范：**

```json
{
  "manifest_version": "1.0",
  "stage": "data-collection",
  "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00",
  
  "cycle": {
    "id": "cycle-YYYYMMDD-XXX",
    "status": "active",
    "started_at": "YYYY-MM-DDTHH:MM:SS+08:00",
    "suggestions_file": "active/cycle-YYYYMMDD-XXX/trade-suggestions.json",
    "is_new_cycle": true
  },
  
  "data_files": {
    "market_data": {
      "path": "data/YYYY-MM-DD.json",
      "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00",
      "source": "OKX + CryptoCompare + alternative.me",
      "status": "success"
    },
    "data_mining_report": {
      "path": "active/cycle-YYYYMMDD-XXX/data-context/data-mining-YYYY-MM-DD-HHMM.md",
      "generated_at": "YYYY-MM-DDTHH:MM:SS+08:00"
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

**日志记录：**
```
[$NOW] [阶段一] 数据清单已生成: data-context/data-manifest-YYYY-MM-DD-HHMM.json
```

---

### 7. Spawn 阶段二

**阶段一完成后，立即 spawn 阶段二：**

```
使用 sessions_spawn 工具：
- agentId: "july"
- mode: "run"
- timeoutSeconds: 0 （不等待完成）
- task: "阶段一数据获取已完成。请读取 tasks/daily-report-stage2.md 开始阶段二分析。数据清单文件：active/cycle-*/data-context/data-manifest-YYYY-MM-DD-HHMM.json"
```

**执行后立即返回**，不等待阶段二完成。

---

### 8. 记录阶段结束

**Spawn 完成后，记录本阶段结束：**

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段一] 完成执行，已 spawn 阶段二" >> logs/daily-report-process.log
echo "[$NOW] [阶段一] ========== 阶段一结束 ========== " >> logs/daily-report-process.log
```

---

## 异常处理

**任何步骤发生异常，根据级别记录日志：**
以下是示例

| 异常类型 | 级别 | 处理方式 |
|---------|------|---------|
| 数据脚本执行失败 | `⛔ ERROR` | 清单标记 `status: "failed"`，继续执行（后续阶段可能无法进行） |
| 数据部分字段缺失 | `⚠️ WARN` | 清单标记 `status: "partial"`，注明缺失字段，继续执行 |
| 周期文件夹创建失败 | `⛔ ERROR` | 记录异常，尝试继续执行（后续文件无法保存） |
| 历史报告路径收集数量不足 | `⚠️ WARN` | 清单中记录实际数量，继续执行 |
| 数据挖掘报告生成失败 | `⚠️ WARN` | 清单中标记挖掘报告缺失，阶段二可直接分析原始数据 |
| 数据清单 JSON 生成失败 | `⛔ ERROR` | 记录异常后结束本阶段（无法 spawn 阶段二） |
| Spawn 阶段二失败 | `⛔ ERROR` | 记录异常后结束本阶段 |

**不因警告中断流程，错误视情况决定是否继续。**

---

## 文件存储规则

| 文件类型 | 路径 | 说明 |
|---------|------|------|
| 市场数据 | `data/YYYY-MM-DD.json` | 脚本自动生成 |
| 数据挖掘报告 | `active/cycle-*/data-context/data-mining-YYYY-MM-DD-HHMM.md` | 本阶段生成 |
| 数据清单 | `active/cycle-*/data-context/data-manifest-YYYY-MM-DD-HHMM.json` | 本阶段生成 |
| 交易建议 | `active/cycle-*/trade-suggestions.json` | 新周期时创建 |
| 日报进程日志 | `logs/daily-report-process.log` | 所有阶段共用 |

---

## 核心要求

1. **首先记录阶段开始**：日志优先，先记录再执行
2. **只检测周期，不读交易建议**：不判断持仓状态，不处理归档
3. **只收集历史报告路径，不读内容**：阶段二自行读取
4. **数据存放在子文件夹**：`data-context/` 与 `reports/` 分离
5. **文件命名带时间信息**：便于区分生成时间
6. **必须生成数据清单 JSON**：固定格式，供阶段二读取
7. **必须 spawn 阶段二**：完成后立即触发下一阶段
8. **最后记录阶段结束**：Spawn 完成后记录
9. **异常分级记录**：`⚠️ WARN` 不中断，`⛔ ERROR` 视情况处理

---

阶段一-v4.15