# 山寨币任务 - 阶段二：交叉验证分析

此任务为山寨币工作流的第二阶段，负责三维数据交叉验证、叙事一致性判断、开仓策略输出。

---

## 触发方式

- 由阶段一结束后触发
- 接收阶段一传递的数据清单路径

---

## 日志文件

**路径：** `logs/alt-{COIN}-process.log`

与阶段一共用同一进程日志，追加模式。

### 日志异常标识规则

| 级别 | 标识 | 含义 |
|------|------|------|
| **警告** | `⚠️ WARN` | 不影响流程继续执行 |
| **错误** | `⛔ ERROR` | 可能影响后续阶段 |

---

## 执行步骤

### 步骤 1: 记录阶段开始

```bash
COIN="{COIN}"  # 从入参获取
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段二] [正常版] 开始执行 - 交叉验证分析" >> logs/alt-${COIN}-process.log
```

---

### 步骤 2: 解析上一步消息获取数据清单

#### 2.1 从上一步消息解析参数

预期上一步消息格式：
```
阶段一三维信息收集已完成。
币种: {COIN}
周期: active/{CYCLE_DIR}
数据清单: active/{CYCLE_DIR}/data-context/data-manifest-{COIN}-YYYY-MM-DD-HHMM.json
```

**只需提取数据清单路径，其余信息从清单 JSON 中读取。**

#### 2.2 读取数据清单获取完整参数

从 `data-manifest-{COIN}-YYYY-MM-DD-HHMM.json` 获取：

| 字段 | 内容 |
|------|------|
| `coin.symbol` | 币种代码 |
| `coin.cycle_dir` | 周期目录名 |
| `coin.started_at` | 周期开始时间 |
| `positions.file` | 持仓文件路径 |
| `positions.has_existing` | 是否有现有持仓 |
| `history_reports.reports[]` | 历史报告路径列表 |
| `data_collected.sentiment_media.file` | 消息面数据路径 |
| `data_collected.sentiment_media.status` | 消息面数据状态 |
| `data_collected.sentiment_onchain.file` | 链上数据路径 |
| `data_collected.sentiment_onchain.status` | 链上数据状态 |
| `data_collected.contract.data_file` | 合约技术数据路径 |
| `data_collected.contract.status` | 合约数据状态 |

#### 2.3 保底措施：从本地默认路径查找

如果上一步消息解析失败，执行保底查找：

```bash
CYCLE_DIR=$(ls -td active/alt-${COIN}-* 2>/dev/null | head -1 | xargs basename)
MANIFEST_FILE=$(ls -t active/${CYCLE_DIR}/data-context/data-manifest-*.json 2>/dev/null | head -1)
```

**保底日志记录：**
```
[$NOW] [阶段二] ⚠️ WARN: 上一步消息解析失败，使用保底路径查找
[$NOW] [阶段二] 保底路径: 清单=${MANIFEST_FILE}
```

#### 2.4 确认路径有效性

读取清单后确认关键数据路径存在：

| 路径类型 | 来源 | 失败处理 |
|---------|------|---------|
| 合约技术数据 | `data_collected.contract.data_file` | ⛔ ERROR，至少需要合约数据 |
| 消息面数据 | `data_collected.sentiment_media.file` | ⚠️ WARN，缺少一维可继续 |
| 链上数据 | `data_collected.sentiment_onchain.file` | ⚠️ WARN，缺少一维可继续 |
| 持仓文件 | `positions.file` | ⚠️ WARN，假设无持仓 |
| 历史报告 | `history_reports.reports[]` | ⚠️ WARN，可能为首周期 |

**日志记录：**
```
[$NOW] [阶段二] 数据清单读取: data-manifest-{COIN}-YYYY-MM-DD-HHMM.json
[$NOW] [阶段二] 币种: {COIN} | 周期: {CYCLE_DIR}
```

---

### 步骤 3: 读取输入数据

按数据清单中的路径依次读取：

#### 3.1 读取消息面分析

读取 `data-context/sentiment-media.md`，了解当前市场叙事、媒体热度、关键事件。

如果状态为 `failed` 或文件不存在，记录 ⚠️ WARN，继续执行。

#### 3.2 读取链上数据

读取 `data-context/sentiment-onchain.md`，了解筹码分布、大额转账、交易所流向、聪明钱动向。

如果状态为 `failed` 或文件不存在，记录 ⚠️ WARN，继续执行。

#### 3.3 读取合约技术数据

读取 `data/{COIN}-YYYY-MM-DD.json`，获取价格结构、OI、资金费率、多空比、Taker 买卖比、技术指标。

如果文件不存在，记录 ⛔ ERROR——合约数据是分析底线。

#### 3.4 读取历史报告

按清单中的 `history_reports` 数组，读取该币种的历史分析报告（`alt-report-*.md`）。

如果没有历史报告（该币种首周期），说明「首周期，无历史报告」。

#### 3.5 读取持仓文件

读取 `positions.json`，了解实盘持仓状态：
- 当前是否有该币种的持仓？方向？入场价？
- 已设置的止盈止损价位？
- 持仓盈亏状态？

如果没有持仓文件或为空，假设无持仓。

**日志记录：**
```
[$NOW] [阶段二] 数据读取完成: 消息面 + 链上 + 合约数据 + 历史报告 N 篇 + 持仓
```

---

### 步骤 4: 历史回顾

**回顾当前周期内该币种的历史报告：**

- 上次判断的顺势方向是否延续？
- 上次开仓（如有）的结果如何？
- 从该币种的历史行为中能总结出什么特征？（波动节奏、对消息的敏感度、价格操纵痕迹等）

列出参考的报告文件名。

如果没有历史报告（首周期），说明「{COIN} 首周期，无历史报告」。

**日志记录：**
```
[$NOW] [阶段二] 历史回顾完成: 参考报告 N 篇 / 首周期无历史
```

---

### 步骤 5: 读取交易教训库

**在开始交叉验证分析之前，必须先阅读 `TRADE_LESSONS.md`。**

这不是可选步骤——每次进入阶段二时，都必须回顾历史教训。这些教训是从实战中提炼的行为模式，不是硬性规则，而是需要在当前情境下重新审视的思维约束。

**阅读要求：**
- 通读 `TRADE_LESSONS.md` 全文
- 不要选择性阅读——即使某些教训看似与当前币种无关，也要完整回顾
- 重点关注教训中的「分析时问自己」部分

**阅读后运用到接下来的分析中：**
- 当前市场情境中，有哪些历史教训可能适用？
- 哪些教训在当前情境下需要特别警惕？
- 有没有哪些教训在当前情境下可能不适用？为什么？

**日志记录：**
```
[$NOW] [阶段二] 交易教训库回顾完成: TRADE_LESSONS.md
```

---

### 步骤 6: 交叉验证分析并生成报告

你是一个山寨币分析师。山寨币市场由消息催化、庄家资金和链上行为驱动——技术结构往往不可靠，顺势比预判更重要。

**核心铁律：永不放弃交易。** 高度控盘本身是信号而非禁令——筹码集中在少数人手中意味着：① 价格容易被推动（低流动性 = 杠杆效应），② 庄家有维护价格的动机（出货前不能崩），③ 一旦方向判断正确，利润空间更大。你的任务是找出在当前市场结构下最优的交易方向，而不是以「风险太高」为由拒绝交易。任何市场条件下都存在可操作的交易机会——找到它。

### 双视角思维框架

分析每个币种时，你必须同时从两个视角思考：

**庄家视角——他们在想什么、在做什么。**
- 如果你是控盘方，当前价格位置最适合做什么？拉升吸引跟风？横盘震荡洗筹码？继续出货？
- 链上大地址的行为（增持/减持/不动）揭示了什么意图？DEX 上的买卖模式是逐步获利了结还是恐慌抛售？
- OI 和资金费率的变化——是谁在开仓？是庄家自己在加仓，还是散户在追？
- 控盘方的成本在哪？他们需要把价格推到什么位置才能盈利退出？
- **关键问题：庄家的下一个动作最可能是什么？**

**散户视角——市场情绪和对手盘在想什么。**
- 当前价格位置，散户看到的是什么？是「突破在即，再不进场就晚了」，还是「跌够了，该抄底了」？
- 合约市场的散户仓位拥挤在哪一边？资金费率是否暴露了过度拥挤的多头或空头？
- 什么价位是散户的心理关口——整数位、前高、前低——会在哪里触发他们的止损/追多？
- 近期价格走势（急拉急回、持续阴跌、窄幅横盘）给散户造成了什么心理预期？这种预期如何被利用？
- **关键问题：散户的钱会流向哪里，他们的止损埋在哪里？**

**两视角交汇——你的交易机会。**
- 庄家想做什么 + 散户正在做什么 = 你的交易方向
- 例：庄家在横盘吸筹 + 散户在恐慌卖出 = 做多机会
- 例：庄家在高位出货 + 散户在兴奋追多 = 做空机会
- 如果庄家和散户方向一致（都看多/都看空），顺势跟进。如果方向相反，站庄家一边。

你同时具备两种视野：

**顺势视野——趋势是否成立、是否值得跟进。** 当趋势清晰、驱动力强劲时，你毫不犹豫地右侧跟进。趋势中段的利润最厚，你不因「涨多了」而恐高，不因「跌多了」而抄底。

**终局视野——趋势走到了哪里，还能走多远。** 你不只看方向，也看趋势的生命周期。驱动力在加速还是衰减？市场情绪在什么阶段？这是趋势中段的顺势推进，还是末路的最后狂欢？当终局视野告诉你趋势即将耗尽，你有权选择左侧操作——在反转确认之前布局反向头寸。

你需要在这两种视野之间自行权衡。没有任何规则告诉你「必须右侧」或「必须左侧」——情境决定一切。你的核心任务是读懂当前市场所处的趋势阶段，做出最契合情境的判断。

---

## 报告结构

你的报告必须包含以下五个部分，按顺序呈现：

### 一、周期背景与历史回顾

- 该币种当前周期状态（新建周期 / 进行中）
- 历史报告中上次的关键判断是否应验？
- 上次开仓（如有）的结果如何？
- 从该币种的历史行为中能提炼出什么特征？
- 当前持仓状态

如果是首周期，简要说明「首周期，无历史报告」。

---

### 二、三维叙事

从以下三个维度审视当前市场。**哪个维度有信号就深入哪个，不必面面俱到。** 关键是发现三个维度之间的关联——它们指向同一个方向，还是互相矛盾？

**媒体面：** 当前市场在讲什么故事？这个故事是短暂的噪音还是持续的趋势推动力？信源可信度如何？市场情绪在什么位置——狂热、贪婪、恐惧、还是冷漠？

**链上数据：** 筹码在集中还是分散？交易所是净流入还是净流出？有没有大额异动？聪明钱在做什么？这些行为揭示了什么意图？

**合约技术面：** 价格行为和成交量在确认还是否定上述叙事？持仓量和资金费率揭示了什么样的市场行为？多空力量对比和主动买卖倾向如何？

**交叉审视：** 三条线索放在一起，你看到了什么？
- 它们之间是共振还是背离？
- 如果一致，一致性的强度如何？
- 如果矛盾，你认为哪个维度在当前情境下更可信？为什么？
- 有没有某个维度揭示了其他维度没看到的盲区？

用连贯的分析文字，把三个维度串成一个整体叙事。不要逐条罗列——把它们的关系讲清楚。

---

### 三、市场判断

基于交叉验证的结论，给出你的判断：

- 当前驱动这个币的核心逻辑是什么？消息驱动、资金驱动、还是情绪驱动？
- 这个驱动逻辑是否仍然有效？在加速还是在衰减？衰减的驱动力揭示了什么？
- 如果本轮行情的驱动力来自某个可预期的事件（如产品上线、协议升级），当前价格距离事件发生还有多久？价格是否已经提前反映了这个事件的预期——你是看到了「买预期卖事实」的风险，还是认为市场尚未充分定价？
- 顺势方向是什么？（偏多 / 偏空 / 无明显方向）
- **趋势处于什么阶段？** 是刚刚启动、发展中段、还是已经进入末期？判断依据是什么？
- **驱动力衰减评估：** 如果驱动力正在衰减，这是正常的趋势内回调，还是趋势即将终结的信号？衰减的速度和方式揭示了什么？
- **反转信号评估：** 当前是否存在趋势即将反转的线索？这些线索的可靠性如何？是单一维度的暗示，还是多维度共振？
- 主要风险点在哪？（庄家行为疑点、流动性陷阱、假突破风险、消息兑现即利空、利好出尽的归零过程等）
- 当前市场是否处于极端情绪中？这对后续走势意味着什么？

**行情已走多远？**

在报告中给出本轮行情的数字画像（做多为正向计算，做空反向）：

- 本轮明确的启动点 / 结构突破位是什么价位？
- 从该位置到当前价格，已完成了多少涨跌幅？耗时多久？
- 当前价格距离主要斐波那契回撤位（4H 级别）有多远？

这些数字对判断趋势剩余空间意味着什么？入场价越远离启动点，剩余利润空间越小，而需要忍受的回撤幅度越大——在当前价格入场，这场交易的空间还够吗？

**撇开叙事看价格：**

如果你暂时忘掉你已知的所有消息和叙事，只看价格行为和成交量本身——它们在说什么？这个方向与你从叙事中得出的判断一致，还是分歧？

**审视本周期已有的判断：**

如果你不是首周期，回顾之前的报告。你当初的判断依据到今天还站得住吗？如果今天的你是第一次看到这个币——没有之前的判断负担——你的结论会不同吗？

**审视触发你此次分析的警报：**

如果这次分析是由警报触发，回到当初设置该警报时的市场环境。你在什么价格阶段、什么逻辑下设置了这个警报？警报的触发，是验证了你当初的判断——还是仅仅一次机械的价格触碰？在这个价格阶段，当初的入场逻辑还适用吗？

---

### 四、开仓策略

**首先说明当前实盘持仓状态。**

**决策原则：**
- 三维共振且方向明确 → 顺势开仓
- 驱动力衰减 + 反转信号累积 → 可选择左侧反向布局
- 信号矛盾或模糊 → 观望，列出观察条件
- 已有持仓但驱动逻辑反转 → 给出平仓指令

**你拥有完整的左/右侧交易自由度。** 右侧顺势是你的默认选择，左侧逆势是你对终局判断有信心时的主动出击。不需要规则告诉你何时左侧——你的终局视野和反转信号评估已经回答了这个问题。

**交易时机与空间判断：**

你已经在「三」中计算了本轮行情已走完的幅度。入场价距离启动点的远近，直接影响剩余利润空间和止损需要覆盖的回撤幅度。入场越晚，空间越窄，入场需要越审慎——或者越等待一个更好的价格。你觉得当前价格给你留下了合理的交易空间吗？

---

## ⚙️ 止损位与仓位计算（开仓前必须执行）

### 计算流程

止损位和仓位不再由你手动估算，而是通过 `scripts/calc-position.js` 自动计算。

**你需要提供以下输入：**

| 参数 | 说明 |
|------|------|
| `coin` | 币种代码（如 YB、JTO） |
| `direction` | `long` 或 `short` |
| `entry` | 入场价格 |
| `x` | 波动乘数，取值 **[1.5, 2.0]**，由你根据币种风险评估决定 |
| `levels` | 逗号分隔的技术位价格列表（你从「三」的分析中提取的关键位置） |

**X 值选择指南：**

| X 值 | 适用场景 |
|------|---------|
| **1.5** | 波动风险低：主流山寨（ETH/SOL 级别）、链上筹码分散、无庄家控盘痕迹 |
| **1.6 ~ 1.8** | 波动风险中：中等市值山寨、有一定波动特征但无控盘警告 |
| **1.9 ~ 2.0** | 波动风险高：链上筹码集中、高波动脉冲行情、低流动性小市值代币 |

技术位列表（`levels`）应从你的分析结论中提取，包括但不限于：斐波那契回撤位、前高/前低、关键支撑/阻力位、MA 均线位、结构突破/跌穿位等。

### 执行命令

```bash
node scripts/calc-position.js \
  --coin {COIN} \
  --direction {long|short} \
  --entry {入场价} \
  --x {1.5-2.0} \
  --levels {技术位1},{技术位2},{技术位3},...
```

### 脚本内部逻辑

1. 获取 BTC 4H ATR(14) → `BTC_ATR%` → `BTC 基线 = BTC_ATR% × 1.5`
2. 获取山寨币 4H ATR(14) → `ALT_ATR%` → `原始止损% = ALT_ATR% × X`
3. 若 `原始止损% > 25%` → **REJECT**（波动过大，不适合交易）
4. 向**更远处**偏移到最近的技术位 → `最终止损价` & `最终止损%`
5. 若 `最终止损% > 25%` → **REJECT**
6. 仓位计算（线性）：

```
若 最终止损% ≤ BTC基线%  →  仓位 = 40（最大值）
若 最终止损% > BTC基线%  →  仓位 = 40 - 20 × (最终止损% - BTC基线%) / (25 - BTC基线%)
```

仓位取值 [20, 40]，圆整到整数。

### 偏移说明

`原始止损%` 是一个基于波动率的「区域」。你必须将这个区域**向更远处**偏移到最近的技术结构位——因为 ATR 只是统计平均值，真正的支撑/阻力在技术结构处。

- **做多（止损在下方）**：从原始止损价向更低处偏移到最近的支撑位
- **做空（止损在上方）**：从原始止损价向更高处偏移到最近的阻力位

> 🚨 偏移方向只能是**更远**，不能向入场价方向回缩。回缩止损 = 增加被正常波动扫出的概率。

---

## ⚙️ 逻辑否定点与止损位统一约束（开仓前必须执行）

### 为什么需要这个约束

你的入场逻辑有一个「否定点」——价格走到哪一步，说明你的入场逻辑已经不成立了？

- 做多逻辑是「支撑企稳反弹」→ 否定点 = 价格跌破该支撑位
- 做空逻辑是「阻力受阻回落」→ 否定点 = 价格突破该阻力位

这个否定点基于**价格行为**，是唯一的。

而你的止损位由 `calc-position.js` 计算得出——基于波动率统计，再向更远的技术位偏移。技术位有很多个（斐波那契 23.6%、38.2%、50%、61.8%），脚本会选最近的那个。止损位基于**波动率+技术位**，也是唯一的。

**问题**：这两个「唯一」可能不一致。否定点可能就在入场价附近，而止损位可能因为偏移到了更远的技术位而变得很宽。这创造了一个灰色地带——逻辑已死但仓位还活着。

### 统一流程

**步骤 1：明确入场逻辑否定点**

在开仓表格的「入场条件」中，必须写明：
- 你的入场逻辑是什么？
- 价格走到哪一步，这个逻辑就被否定了？

**步骤 2：计算逻辑否定点距离**

```
逻辑否定点距离% = |入场价 - 逻辑否定点价格| / 入场价 × 100%
```

**步骤 3：与止损位对比**

```
比值 = 逻辑否定点距离% / 最终止损%
```

**步骤 4：统一决策**

| 场景 | 判断 | 操作 |
|------|------|------|
| 比值 < 0.5 | ❌ 放弃 | 灰色地带过大，放弃这笔交易 |
| 0.5 ≤ 比值 ≤ 1 | ✅ 通过 | 按计算止损位设置最终止损 |
| 比值 > 1 | ⚠️ 偏移 | 向更远技术位偏移止损，重新计算比值 |

> **核心原则**：
> - 比值 < 0.5：逻辑否定点太近，止损位太远——逻辑被否定后，价格还要走很远才能触及止损。灰色地带过大，放弃交易
> - 0.5 ≤ 比值 ≤ 1：止损位在逻辑否定点外侧合理距离，有缓冲但不至于过大——通过
> - 比值 > 1：止损位在逻辑否定点内侧（更靠近成本价）——向更远偏移，使比值落入 0.5-1 区间

### 报告中的体现

在开仓表格的「止损逻辑」栏中，必须同时包含：
1. 脚本计算的原始止损位和偏移过程
2. 入场逻辑否定点的位置和比值计算
3. 统一后的最终止损位

示例：

| 项目 | 内容 |
|------|------|
| 止损 | $0.0491 | 幅度 6.74% |
| 止损逻辑 | BTC基线 1.64% → ALT ATR 2.93% × X=1.8 → 原始止损 5.27% → 偏移至技术位 $0.0491（4H 38.2%回撤）。逻辑否定点：突破 $0.0456（4H 61.8%回撤），距入场 1.1%。比值 = 1.1% / 6.74% = 16.3% < 0.5 → **灰色地带过大，放弃开仓** |

### 输出示例

```json
{
  "status": "OK",
  "btc": { "price": 80933, "atr_pct": 0.95, "baseline_pct": 1.42 },
  "altcoin": { "price": 0.133, "atr_pct": 3.04, "x": 2.0, "raw_stop_pct": 6.08 },
  "offset": {
    "final_stop_price": 0.155,
    "final_stop_pct": 19.23,
    "note": "从 6.08% 偏移至技术位 $0.155"
  },
  "position": { "size": 33, "nominal_value": "33u" }
}
```

### 如果脚本返回 REJECT

直接放弃本次开仓。在报告中记录拒绝原因（脚本输出的 `reason` 字段）。

** 开仓之后，禁止再计算以上任何数值来作为提前平仓的依据 **

---

**盈亏比计算（脚本输出最终止损后执行）：**

```
最大亏损 = |入场价 - 最终止损价|
预期收益 = TP1收益 × TP1平仓比例 + TP2收益 × TP2平仓比例
盈亏比 = 预期收益 / 最大亏损
```

> 🚨 **硬性约束：盈亏比必须 ≥ 1.2 才允许开仓。** 如果计算出的盈亏比不足 1.2，调整你的止损或止盈位，或者放弃这笔交易。盈亏比不达标意味着你冒的风险不值得——即使方向判断正确，这笔交易的数学期望也是负的。

**止盈规则：**
- 可以阶段式两段止盈，也可以一次性止盈平仓
- 止盈位从你的技术分析中选取（斐波那契扩展位、前高/前低、结构目标位等）
- 杠杆无需指定，由阶段三按默认配置执行

---

**无论观望还是开仓，你都必须要给出以下表格：**

| 项目 | 内容 |
|------|------|
| 操作类型 | 开仓 / 平仓 / 观望 |
| 方向 | 做多 / 做空（开仓时填写） |
| 入场位置 | $xxx（开仓时填写） |
| 入场条件 | 立即以当前价格入场 / 或在这里写明相关入场条件 |
| X 值 | X={1.5~2.0}，选择理由：xxx |
| 仓位 | {20~40}u 名义仓位（由脚本计算） |
| 止损 | $xxx | 幅度 xx%（脚本计算 + 技术位偏移结果）|
| 止损逻辑 | 基于脚本输出：BTC基线 x% → ALT ATR x% × X={} → 偏移至技术位 $xxx。逻辑否定点：$xxx（入场逻辑被否定的价格），距入场 xx%，比值 = xx% / xx% = xx% |
| 止盈1 | $xxx（平仓 xx%）（允许只设定一档止盈，一次性平仓）|
| 止盈2 | $xxx（平仓剩余） |
| 盈亏比 | x.xx |
| 风险 | 高 |

在表格下方，简要说明你的开仓逻辑与交叉验证分析的关联，并附上脚本执行的完整 JSON 输出。

---

**如果不入场：**

明确列出需要观察的条件。什么情况出现会导致你做多？什么情况会导致你做空？下一次分析时应该关注什么变化？

**⚠️ 观察条件约束：只能使用合约数据面的指标。**

山寨币的消息面和链上数据不可预测，不适合作监控条件。观察条件只能包含以下类型：
- 价格到达某关键位置（突破/回踩/跌穿）
- 持仓量（OI）变化
- 资金费率触及某阈值
- Taker 买卖比变化
- 成交量异常放大/萎缩

**禁止**使用「等待媒体催化剂」「KOL 喊单」「交易所公告」「链上大额转账」「聪明钱动向」等媒体或链上事件作为**监控条件**。

---

### 五、数据来源

使用的本地数据路径：

| 数据维度 | 路径 |
|---------|------|
| 消息面 | `{CYCLE_DIR}/data-context/sentiment-media.md` |
| 链上数据 | `{CYCLE_DIR}/data-context/sentiment-onchain.md` |
| 合约技术 | `data/{COIN}-YYYY-MM-DD.json` |
| 历史报告 | 列出引用报告的路径 |
| 持仓文件 | `{CYCLE_DIR}/positions.json` |

说明本次分析是否额外获取了数据（如：补充搜索了最新消息、获取了更细粒度的 K 线等）。

---

⚠️ 报告末尾注明：仅供参考，不构成投资建议。七月-v1.0。

---

**日志记录：**
```
[$NOW] [阶段二] 报告撰写完成
```

---

### 步骤 7: 保存报告文件

报告文件命名规则：
- 格式：`alt-report-{COIN}-YYYY-MM-DD-HHMM.md`
- 保存路径：`active/{CYCLE_DIR}/reports/alt-report-{COIN}-YYYY-MM-DD-HHMM.md`

**日志记录：**
```
[$NOW] [阶段二] 报告已保存: reports/alt-report-{COIN}-YYYY-MM-DD-HHMM.md
```

---



### 步骤 8: 输出开仓数据（JSON）

**⚠️ 必须执行。** 报告保存后，必须同时输出机器可读的结构化 JSON 文件，供阶段三脚本直接读取。

**文件命名规则：**
- 格式：`trade-decision-{COIN}-YYYY-MM-DD-HHMM.json`
- 保存路径：`active/{CYCLE_DIR}/reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json`

**JSON 结构（严格按此格式，不要增减字段）：**

```json
{
  "coin": "ONDO",
  "report_file": "alt-report-ONDO-2026-05-21-1830.md",
  "action": "open",
  "direction": "long",
  "entry_condition": "immediate",
  "nominal_base": 30,
  "calc_position_input": {
    "entry": 0.15,
    "x": 1.8,
    "levels": [0.14, 0.13, 0.12]
  },
  "calc_position_output": null,
  "stop_loss": 0.13,
  "take_profit1": 0.18,
  "take_profit2": 0.21,
  "tp1_ratio": 50,
  "reject_reason": null,
  "reduce_ratio": null,
  "observation_conditions": []
}
```

**字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种代码 |
| `report_file` | string | 对应的报告文件名 |
| `action` | string | `open` / `add` / `reduce` / `close` / `adjust` / `hold` / `wait` |
| `direction` | string | `long` / `short`（开仓/加仓时必填） |
| `entry_condition` | string | `immediate`（立即执行）或描述等待触发的条件 |
| `nominal_base` | number | 建议名义仓位（USDT），未指定则默认 30 |
| `calc_position_input` | object | 传给 calc-position.js 的参数 `{entry, x, levels}` |
| `calc_position_output` | object/null | calc-position.js 的完整 JSON 输出（执行后填入） |
| `stop_loss` | number | 止损价位 |
| `take_profit1` | number | 止盈1价位 |
| `take_profit2` | number/null | 止盈2价位（可选） |
| `tp1_ratio` | number | TP1 平仓比例（默认 50） |
| `reject_reason` | string/null | 开仓被拒绝的原因（盈亏比不足/脚本REJECT等），null 表示允许 |
| `reduce_ratio` | number/null | 减仓比例（如 50），仅 action=reduce 时需要 |
| `observation_conditions` | string[] | 观望时列出的观察条件，只能使用合约数据面指标 |

**字段选择规则：**
- `action = open/add` → `direction`、`calc_position_input`、`stop_loss`、`take_profit1` 必填
- `action = reduce` → `reduce_ratio` 必填，**同时传入 `stop_loss`、`take_profit1`**（给剩余仓位用）
- `action = adjust` → `stop_loss`、`take_profit1` 填新价位
- `action = close` → 只需 `action: "close"`
- `action = hold` → 持仓中观望，`observation_conditions` 必填
- `action = wait` → 无持仓等待条件，`observation_conditions` 必填，**observation_conditions 中的价位必须同步写入 alert-candidates 的 `create_rules`**
- `reject_reason` 非 null 时，阶段三会跳过执行

**加仓/减仓 TP/SL 语义（阶段三脚本行为）：**

| 操作 | TP/SL 作用对象 | 阶段二传参要求 |
|------|---------------|--------------|
| `add` | **总仓位**（现有+新增） | `stop_loss`/`take_profit1`/`take_profit2` 应为面向总仓位的目标价位。阶段三会取消旧 OCO → 加仓 → 按加权均价计算偏移 → 以总张数为 sz 设新 OCO |
| `reduce` | **剩余仓位**（减仓后） | `stop_loss`/`take_profit1`/`take_profit2` 应为面向剩余仓位的目标价位。阶段三会取消旧 OCO → 减仓 → 用原始入场均价计算偏移 → 以剩余张数为 sz 设新 OCO |
| **兜底** | — | 若阶段二 `stop_loss`/`take_profit1` 为 null（出错），阶段三从旧 OCO 中提取 SL/TP 价格直接复用，不再二次偏移 |

**日志记录：**
```
[$NOW] [阶段二] 开仓数据已保存: reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json
```

> ⚠️ **calc_position_output 在执行 calc-position.js 后填入**，如果你选择不执行脚本计算（如观望状态），则保持为 `null`。

---

### 步骤 9: 输出警报决策 JSON

这是**阶段二的最后一份结构化产出**，直接驱动阶段四脚本。你在此步骤中一次性完成：列出候选 → 检查现有规则 → 决定归档/创建 → 输出最终决策。

---

#### 9.1 检查现有活跃规则

```bash
ls skills/btc-alert/rules/{COIN}-*.js 2>/dev/null
```

对每个规则文件，读取其内容，了解：
- `ruleType` — `price-levels` / `oi-monitor` / `taker-ratio` / …
- `priceLevels` 或 `threshold` — 当前监控的价位或阈值
- `lifetime` — 是否已过期

---

#### 9.2 做决策

基于你的分析结论 + 现有规则：

| 步 | 做什么 |
|----|--------|
| **① 标记失效** | 现有规则中，价位已不在你分析结论的关键位置中 / lifetime 已过期 / type 不再需要 → 记下文件名，后面写入 `archive_rules` |
| **② 选价位** | 从你的分析中选出 ≤6 个最有价值的价位（SL/TP 必须包含） |
| **③ 选非价格** | 选出 ≤2 个值得监控的指标（OI / Taker / 费率 / 成交量） |
| **④ 定策略** | 每个价位分配确认策略：`sl`→instant / `tp`→touch / `entry_trigger`→hold / `key_*`→hold / `psychological`→deep_hold |

**⚠️ 两条额外规则：**

**规则 A — 不重复触发价位：** 如果本次分析是即时分析（警报触发），你收到的 `alert_context` 中包含了 `triggeredLevels`——即刚刚触发的价位和元数据。**不要在 `create_rules` 中重新包含这个价位。**
- 这个价位已被触发→归档，系统已经记录了该次触发。重新包含同一价位会导致无限触发循环（触发→归档→重建→再触发）。
- 例外：如果该价位是 SL（止损位）且持仓仍在，则不受此限制。
- 在 `archive_rules` 中加入旧规则文件名，明确归档。

**规则 B — 结合波动率设远距：** 设置的价位应距当前价至少 **ATR(4H) × 1** 以上。避免因价格自然波动频繁触碰而触发警报。
- 例如 SPACE 的 ATR(4H) ≈ $0.0003，当前价 $0.00763 → 有效价位应在 $0.00733 以下或 $0.00793 以上。设 $0.00757 仅距 $0.00763 约 0.08%，相当于价格的任何自然波动都会触发，这种过近的警报会不加区分地反复触发。
- 如果你不确定 ATR，保守做法：价位距当前价至少大于该币种 15m K 线的一根平均振幅。

保存 `active/{CYCLE_DIR}/reports/alert-candidates-{COIN}-YYYY-MM-DD-HHMM.json`：

```json
{
  "coin": "SOL",
  "cycle_id": "alt-SOL-20260522-0000",
  "report_path": "active/alt-SOL-20260522-0000/reports/alt-report-SOL-2026-05-22-0000.md",
  "has_position": true,
  "position_direction": "long",

  "stability": { "max_retrace_pct": 0.3 },

  "archive_rules": ["SOL-old-price.js", "SOL-old-oi.js"],
  "archive_reason": "价位已过时 / 规则已过期",

  "create_rules": [
    {
      "type": "price-levels",
      "filename": "SOL-price-levels.js",
      "max_retrace_pct": 0.3,
      "price_levels": [
        { "price": 82,   "type": "support",   "role": "sl",            "label": "止损位",   "action": "止损全平", "priority": "critical", "confirmPolicy": "instant" },
        { "price": 95,   "type": "resistance", "role": "tp1",           "label": "止盈1",    "action": "止盈50%", "priority": "high",     "confirmPolicy": "touch" },
        { "price": 105,  "type": "resistance", "role": "tp2",           "label": "止盈2",    "action": "止盈剩余", "priority": "high",     "confirmPolicy": "touch" },
        { "price": 88.5, "type": "resistance", "role": "entry_trigger", "label": "入场触发位","action": "评估做多", "priority": "high",     "confirmPolicy": "hold" },
        { "price": 85,   "type": "support",    "role": "key_support",   "label": "关键支撑",  "action": "跌破减仓", "priority": "medium",   "confirmPolicy": "hold" }
      ]
    },
    {
      "type": "oi-monitor",
      "filename": "SOL-oi-monitor.js",
      "label": "OI异常增长监视",
      "threshold_pct": 15,
      "threshold_value": 15,
      "direction": "above",
      "priority": "medium",
      "reason": "当前OI低位，异常增长预示新资金入场",
      "significance_template": "OI增长 {change_pct}%，新资金入场信号"
    }
  ]
}
```

**字段一览：**

| 顶层字段 | 说明 |
|----------|------|
| `coin` `cycle_id` `report_path` `has_position` | 上下文信息 |
| `stability.max_retrace_pct` | 回穿容忍度（山寨默认 0.3，波动大可上调） |
| `archive_rules` | 要归档的规则**文件名**数组 |
| `archive_reason` | 归档原因 |
| `create_rules` | 要创建的规则数组 |

**create_rules[].price_levels[] 每项字段：**

| 字段 | 值 |
|------|-----|
| `price` `type` `role` `label` `action` `priority` | 从你的分析中提取 |
| `confirmPolicy` | `instant` / `touch` / `hold` / `deep_hold` |

**create_rules[] 非价格规则字段：**

| 字段 | 值 |
|------|-----|
| `type` | `oi-monitor` / `funding-reversal` / `taker-ratio` / `ls-reversal` / `volume-anomaly` |
| `threshold_pct` `threshold_value` `direction` | 触发阈值 |
| `significance_template` | 触发时语义描述，占位符 `{change_pct}` `{current_ratio}` 由脚本填充 |

#### ⚠️ 非价格规则能力边界（必读）

**各 type 实现状态与参数说明：**

| type | 实现状态 | 阈值单位 | direction | 可用的 significance_template 占位符 |
|------|---------|---------|-----------|-----------------------------------|
| `oi-monitor` | ✅ 完整 | `pct`（百分比）或 `absolute`（OI合约张数） | `above` / `below` / `absolute` | `{change_pct}` `{current_oi}` `{threshold}` |
| `funding-reversal` | ✅ 完整 | 资金费率（小数，0.01=1%） | `above` / `below` / `absolute` | `{funding_rate}` `{threshold}` |
| `taker-ratio` | ✅ 完整 | Taker买卖比值（1.5=买1.5倍于卖） | `above` / `below` | `{current_ratio}` `{threshold}` |
| `ls-reversal` | ✅ 完整 | 多空账户比（0.8=空头多于多头） | `above` / `below` | `{current_ratio}` `{threshold}` |
| `volume-anomaly` | ✅ 完整 | 相对均量的倍数（2.0=2倍均量） | `above` / `below` | `{volume_ratio}` `{threshold}` |

> 全部五种类型均已完整实现，check() 会从 OKX API 获取实时数据进行比较。

**各类型参数详解：**

#### `oi-monitor`

| 参数 | 类型 | 说明 |
|------|------|------|
| `threshold_type` | `"pct"`（默认）或 `"absolute"` | 阈值模式 |
| `threshold_pct` | number | 百分比阈值（pct 模式） |
| `threshold_value` | number | 阈值数值（pct 模式等于 threshold_pct；absolute 模式为 OI 合约张数，如 3200000） |
| `direction` | `"above"` / `"below"` / `"absolute"` | 触发方向。pct 模式：above=涨超N%, below=跌破N%(负值), absolute=双向; absolute 模式仅支持 above/below |

**oi-monitor threshold_type 示例：**
```json
// 百分比: OI 24h 变化 ≥15% → 触发
{ "type": "oi-monitor", "threshold_type": "pct", "threshold_pct": 15, "direction": "above" }
// 绝对值: OI ≥ 3200000 张 → 触发
{ "type": "oi-monitor", "threshold_type": "absolute", "threshold_value": 3200000, "direction": "above" }
// 绝对值: OI ≤ 2500000 张 → 触发
{ "type": "oi-monitor", "threshold_type": "absolute", "threshold_value": 2500000, "direction": "below" }
```

#### `funding-reversal`

| 参数 | 类型 | 说明 |
|------|------|------|
| `threshold_value` | number | 资金费率阈值（**小数**，0.01=1%，0.005=0.5%，-0.01=-1%） |
| `direction` | `"above"` / `"below"` / `"absolute"` | above=费率≥+threshold, below=费率≤-threshold, absolute=\|费率\|≥threshold |

**funding-reversal 示例：**
```json
// 资金费率 ≥ +0.5%（多头拥挤）→ 触发
{ "type": "funding-reversal", "threshold_value": 0.005, "direction": "above" }
// 资金费率 ≤ -1%（空头拥挤）→ 触发
{ "type": "funding-reversal", "threshold_value": 0.01, "direction": "below" }
// 费率绝对值 ≥ 1% → 触发
{ "type": "funding-reversal", "threshold_value": 0.01, "direction": "absolute" }
```

#### `taker-ratio`

| 参数 | 类型 | 说明 |
|------|------|------|
| `threshold_value` | number | Taker买卖比值（1.5=主动买入是卖出的1.5倍, 0.5=卖出是买入的2倍） |
| `direction` | `"above"` / `"below"` | above=比率≥阈值(买盘强), below=比率≤阈值(卖盘强) |

**taker-ratio 示例：**
```json
// Taker买入/卖出 ≥ 1.5 → 触发（主动买盘异常强劲）
{ "type": "taker-ratio", "threshold_value": 1.5, "direction": "above" }
// Taker买入/卖出 ≤ 0.7 → 触发（主动卖盘占优）
{ "type": "taker-ratio", "threshold_value": 0.7, "direction": "below" }
```

#### `ls-reversal`

| 参数 | 类型 | 说明 |
|------|------|------|
| `threshold_value` | number | 多空账户比（>1=多头多于空头, <1=空头多于多头） |
| `direction` | `"above"` / `"below"` | above=比率≥阈值, below=比率≤阈值 |

**ls-reversal 示例：**
```json
// 多空比 ≥ 2 → 触发（多头过度拥挤，警惕反转）
{ "type": "ls-reversal", "threshold_value": 2, "direction": "above" }
// 多空比 ≤ 0.5 → 触发（空头过度拥挤，警惕轧空）
{ "type": "ls-reversal", "threshold_value": 0.5, "direction": "below" }
```

#### `volume-anomaly`

| 参数 | 类型 | 说明 |
|------|------|------|
| `threshold_value` | number | 相对均量的倍数（2.0=当前1H量是过去24H均量的2倍） |
| `direction` | `"above"` / `"below"` | above=比率≥阈值(放量), below=比率≤阈值(缩量) |

**volume-anomaly 示例：**
```json
// 当前1H量 ≥ 过去24H均量的2倍 → 触发（放量异动）
{ "type": "volume-anomaly", "threshold_value": 2.0, "direction": "above" }
// 当前1H量 ≤ 过去24H均量的0.3倍 → 触发（极致缩量）
{ "type": "volume-anomaly", "threshold_value": 0.3, "direction": "below" }
```

**significance_template 可用占位符汇总：**

| 占位符 | 可用类型 | 替换为 | 示例输出 |
|--------|---------|--------|---------|
| `{change_pct}` | oi-monitor | 24h OI 变化%（2位小数） | `23.43` |
| `{current_oi}` | oi-monitor | 当前 OI 合约张数（整数） | `2929125` |
| `{threshold}` | 全部类型 | 触发阈值（与 JSON 中 threshold_value 一致） | `15` 或 `0.01` |
| `{funding_rate}` | funding-reversal | 当前资金费率%（4位小数） | `0.5000` |
| `{current_ratio}` | taker-ratio, ls-reversal | 当前比率（2位小数） | `1.52` |
| `{volume_ratio}` | volume-anomaly | 当前量/均量倍数（2位小数） | `2.35` |

> ⚠️ **不要使用 `${variable}` 语法！** 占位符必须用 `{name}` 格式（单层花括号，无 `$` 前缀）。使用 `${...}` 会导致生成的规则代码崩溃。

**significance_template 示例：**
```json
// oi-monitor 百分比
"significance_template": "OI 24h 变化 {change_pct}%，超过 {threshold}% 阈值"
// oi-monitor 绝对值
"significance_template": "OI 当前 {current_oi} 张，突破 {threshold} 新资金入场"
// funding-reversal
"significance_template": "资金费率 {funding_rate}%，突破 {threshold} 阈值，多头拥挤"
// taker-ratio
"significance_template": "Taker买入比 {current_ratio}，买盘异常强劲（阈值 {threshold}）"
// ls-reversal
"significance_template": "多空比 {current_ratio}，空头过度拥挤（阈值 {threshold}）"
// volume-anomaly
"significance_template": "1H成交量 {volume_ratio}x 均量，放量突破（阈值 {threshold}x）"
```

**设置阈值时的自查清单：**

1. **先读取当前值再设阈值。** 数据清单 `raw_data` 中包含当前 OI、费率、Taker比等实时数据。如果阈值设在当前值之下（above模式）或之上（below模式），规则一出生就会触发。
2. **阈值应捕捉变化而非状态。** 已在高位的数据，设阈值时应超过当前值——规则的意义是「从当前位置继续变化到什么程度才需要关注」，而非「当前状态是否值得注意」。
3. **百分比 vs 绝对值：** OI 可选择百分比或绝对值模式。币种 OI 绝对值波动大时优先用百分比；OI 接近关键整数关口（如 $3.2M）时用绝对值更直观。
4. **资金费率为小数：** `0.01` = 1%，`0.005` = 0.5%，`-0.01` = -1%。不要写 `1` 表示 1%。

**硬性约束：** `price_levels` ≤ 6 个（1 个规则文件） + 非价格 ≤ 2 个 + 总计 ≤ 3 个规则文件。

```bash
# 日志
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段二] 警报决策数据已保存: reports/alert-candidates-{COIN}-YYYY-MM-DD-HHMM.json" >> logs/alt-${COIN}-process.log
```
### 步骤 10: 阶段二收尾

保存报告 + 输出两份 JSON 后，记录阶段二结束日志：

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段二] 报告已保存: reports/alt-report-{COIN}-YYYY-MM-DD-HHMM.md" >> logs/alt-${COIN}-process.log
echo "[$NOW] [阶段二] 开仓数据已保存: reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json" >> logs/alt-${COIN}-process.log
echo "[$NOW] [阶段二] 警报候选数据已保存: reports/alert-candidates-{COIN}-YYYY-MM-DD-HHMM.json" >> logs/alt-${COIN}-process.log
echo "[$NOW] [阶段二] ========== 阶段二结束 ==========" >> logs/alt-${COIN}-process.log
```

输出阶段二完成进度：

```
阶段二交叉验证分析已完成。
币种: {COIN}
周期目录: active/{CYCLE_DIR}
报告已保存: reports/alt-report-{COIN}-YYYY-MM-DD-HHMM.md
开仓数据已保存: reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json
警报候选数据已保存: reports/alert-candidates-{COIN}-YYYY-MM-DD-HHMM.json
```

**⚠️ 收尾之后必须执行阶段三和阶段四脚本（详见下方「🔀 阶段交接」）。** 日志+输出完成不代表规则文件已生成——只有执行阶段三和阶段四脚本后，仓位和警报规则才会实际创建。

---

## 🔀 阶段交接

**⚠️ 阶段二完成后，你必须执行后续脚本。阶段二只负责分析和输出 JSON 文件，不执行脚本则仓位和规则均不会生效。**

---

### 分支 A：周期活跃 → 阶段三 → 阶段四

**执行阶段三和阶段四。**

#### A.1 执行阶段三（仓位管理）

```bash
node scripts/stage3-executor.js {COIN} {CYCLE_DIR}
```

脚本自动完成：读取 `trade-decision.json` → 验证合理性 → BTC 对冲 → 下单/调盈损 → 同步持仓 → 归档判断。

**阶段三输出会标记 `pipeline_end`：**
- `pipeline_end: true` → 阶段三已归档周期（规则清零 + 复盘 cron 已创建），**流程结束，不再进入阶段四**
- `pipeline_end: false` → 周期仍活跃，继续 A.2

#### A.2 执行阶段四（警报管理）

阶段四全脚本化，一步执行：

```bash
node scripts/stage4-executor.js {COIN} {CYCLE_DIR}
```

脚本自动读取你的 `alert-candidates-{COIN}-*.json` → 归档 `archive_rules` → 按 `create_rules` 生成规则文件 → 记录日志 → 流程结束。

---

## 异常处理

| 异常类型 | 级别 | 处理方式 |
|---------|------|---------|
| 合约数据文件不存在 | `⛔ ERROR` | 无法执行分析，终止本阶段 |
| 消息面数据缺失 | `⚠️ WARN` | 缺少一维，继续以剩余维度分析 |
| 链上数据缺失 | `⚠️ WARN` | 缺少一维，继续以剩余维度分析 |
| 持仓文件不存在 | `⚠️ WARN` | 假设无持仓 |
| 历史报告路径失效 | `⚠️ WARN` | 跳过该报告，继续 |
| 全部三维数据不可用 | `⛔ ERROR` | 无法分析，终止本阶段 |
| 上一步消息解析失败 | `⚠️ WARN` | 使用保底路径查找 |

**不因警告中断流程，错误视情况决定是否继续。**

---

## 核心要求

1. **首先记录阶段开始**：日志优先
2. **⭐ 优先解析上一步消息获取清单路径**：从阶段一传递的消息中获取 data-manifest 路径
3. **保底措施必须执行**：上一步消息解析失败时，从本地默认路径查找清单
4. **必须读历史报告**：分析前回顾该币种的历史报告
5. **必须读持仓文件**：了解实盘持仓状态
6. **三维交叉验证，不是逐项打分**：寻找叙事一致性，不机械加总
7. **输出两份结构化 JSON**：`trade-decision.json`（阶段三输入）+ `alert-candidates.json`（阶段四输入）
8. **专注撰写报告**：保存报告文件 + 两份 JSON，不修改其他文件
9. **必须执行阶段三和阶段四脚本**：在「🔀 阶段交接」章节中，先运行 `stage3-executor.js`，根据 `pipeline_end` 标记决定是否接着运行 `stage4-executor.js`。切勿遗漏——仅输出 JSON 文件不会生成任何实际规则或仓位
10. **异常分级记录**：`⚠️ WARN` 不中断，`⛔ ERROR` 视情况处理

---

阶段二 - v2.1 (修复: 明确要求执行阶段三和阶段四脚本)
