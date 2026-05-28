# 庄币任务 - 阶段二：庄家行为交叉验证分析

此任务为庄币工作流的第二阶段，负责三维数据交叉验证、庄家行为识别、闪电战策略输出。

> ⚠️ 数据收集流程与山寨币管线一致（步骤 1-4），但分析框架（步骤 5）围绕「读懂庄家」设计。

---

## 触发方式

- 由阶段一结束后触发
- 接收阶段一传递的数据清单路径

---

## 日志文件

**路径：** `logs/zhuang-{COIN}-process.log`

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
echo "[$NOW] [阶段二] [庄币版] 开始执行 - 交叉验证分析" >> logs/zhuang-${COIN}-process.log
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
CYCLE_DIR=$(ls -td active/zhuang-${COIN}-* 2>/dev/null | head -1 | xargs basename)
MANIFEST_FILE=$(ls -t active/${CYCLE_DIR}/data-context/data-manifest-*.json 2>/dev/null | head -1)
```

**保底日志记录：**
```
[$NOW] [阶段二] ⚠️ WARN: 上一步消息解析失败，使用保底路径查找
[$NOW] [阶段二] 保底路径: 清单=${MANIFEST_FILE}
```

---

### 步骤 3: 读取输入数据

按数据清单中的路径依次读取：

#### 3.1 读取消息面分析

读取 `data-context/sentiment-media.md`，了解当前市场叙事、媒体热度、KOL 喊单、项目方动作。

如果状态为 `failed` 或文件不存在，记录 ⚠️ WARN，继续执行。

#### 3.2 读取链上数据

读取 `data-context/sentiment-onchain.md`，了解筹码分布、大额转账、持仓集中度、DEX 行为。

如果状态为 `failed` 或文件不存在，记录 ⚠️ WARN，继续执行。

#### 3.3 读取合约技术数据

读取 `data/{COIN}-YYYY-MM-DD.json`，获取价格结构、OI、资金费率、多空比、Taker 买卖比、技术指标。

如果文件不存在，记录 ⛔ ERROR——合约数据是分析底线。

#### 3.4 读取历史报告

按清单中的 `history_reports` 数组，读取该币种的庄币历史分析报告（`zhuang-report-*.md`）。

如果没有历史报告（该币种首周期），说明「首周期，无历史报告」。

#### 3.5 读取持仓文件

读取 `positions.json`，了解实盘持仓状态。

如果没有持仓文件或为空，假设无持仓。

**日志记录：**
```
[$NOW] [阶段二] 数据读取完成: 消息面 + 链上 + 合约数据 + 历史报告 N 篇 + 持仓
```

---

### 步骤 4: 历史回顾

**回顾当前周期内该币种的历史报告：**

- 上次判断的庄家行为阶段是否应验？
- 上次开仓（如有）的结果如何？
- 从该币种的历史行为中提炼特征：这是第几波脉冲？庄家习惯用什么手法？

列出参考的报告文件名。如果没有历史报告（首周期），说明「{COIN} 首周期，无历史报告」。

**日志记录：**
```
[$NOW] [阶段二] 历史回顾完成: 参考报告 N 篇 / 首周期无历史
```

---

### 步骤 5: 交叉验证分析并生成报告

你是庄币分析师。你面前的币种是一个被庄家高度控盘的市场。技术分析的常规规律在这里可能完全失效。你的任务是：**读懂庄家意图，站在庄家一边。**

---

## 🔥 庄币分析框架

### 核心思维转变

不要用 RSI 超卖、支撑回踩这些常规框架去理解庄币——庄家可以画出任何技术形态。真正的分析问题是：**这个价位，庄家在建仓还是在出货？K 线上散户看到什么、会怎么反应？庄家下一步想让散户看到什么信号来引诱他们站错边？**

庄币市场的本质是：**庄家画图给散户看，散户按图操作，庄家反向收割。** 你不想成为被收割的散户——你要做的是站在画图的那个人旁边。

---

### 一、庄家行为阶段识别

每一个庄币都在走以下四个阶段之一。你的首要任务是判断当前处于哪个阶段：

#### 🥚 阶段一：吸筹（Accumulation）

**特征：**
- 价格在窄幅区间横盘，波动率异常低（相对该币种历史水平）
- OI 缓慢上升，但价格不涨——庄家在合约市场悄悄建仓
- 成交量萎缩到地量——散户没兴趣，庄家在无人注意时入场
- 资金费率中性或微负——没有过度拥挤的方向
- 链上筹码集中度上升，大地址在增持

**散户心理：** 「这币死了，已归零，没人玩了」

**你的操作：** 这是最佳入场时机——但需要耐心。庄家吸筹可能持续数天。信号确认：OI 持续上升 + 价格不跌 + 成交量地量。

#### 🚀 阶段二：拉升（Launch）

**特征：**
- 价格突破横盘区间，出现第一根大阳线（4h 涨 >10%）
- OI 与价格同步飙升——庄家通过合约杠杆推高价格
- 成交量爆发式增长，远超均量
- 资金费率仍然不极端——散户还没反应过来
- Taker 买入比急剧飙升（>1.3）

**散户心理：** 「卧槽，起飞了！现在进场还来得及吗？」

**你的操作：** 刚突破时立即跟进——这是利润最厚的阶段。越晚入场，盈亏比越差。但必须在确认不是假突破后入场（至少要等突破位上方站稳 15 分钟）。

#### 💀 阶段三：派发（Distribution）

**特征：**
- 价格高位横盘，不再创新高，但也不回落——庄家在出货中维持价格
- OI 开始下降，但价格横盘——庄家在平多单
- 资金费率极端正（>0.05%）——散户多头拥挤
- Taker 买入比回落至 1.0 以下——庄家不再主动买
- 成交量在高位萎缩——买盘衰竭

**散户心理：** 「回调就是加仓机会！冲向月球！」

**你的操作：** **这是最危险的阶段。绝不追多。** 可以在确认派发信号后布局做空——但需要耐心等待庄家完成出货。

#### 📉 阶段四：崩盘（Crash）

**特征：**
- 价格跌破派发区间下沿
- OI 断崖式下跌——多头踩踏
- 资金费率从极端正转向极端负——恐慌做空
- 连续大阴线，无反弹

**散户心理：** 「完了全完了，割肉吧」

**你的操作：** 远离。不要抄底——底部由庄家决定，不是由技术位决定。等吸筹信号再出现。

---

### 二、庄家指纹识别——关键信号解读

以下信号的庄币解读：

#### 资金费率的特殊意义

| 组合 | 普通解读 | 庄币解读 | 操作 |
|------|---------|---------|------|
| 费率极端负（<-0.1%）+ 价格横盘 | 空头拥挤，可能反弹 | **庄家吸筹中，准备轧空拉升** | 🟢 强烈看多 |
| 费率极端正（>0.1%）+ 价格高位 | 多头拥挤，注意回调 | **庄家出货中，等待砸盘** | 🔴 绝不追多，考虑做空 |
| 费率从中性转负 + 价格已涨 | 短线空头入场 | **庄家洗盘——震掉跟风盘** | 🟡 持仓不动或加仓 |
| 费率从极端回归中性 + 价格已走远 | 情绪正常化 | **庄家已调整完仓位，行情转向** | 🔴 立即平仓 |

> 🚨 庄币的资金费率极端阈值是 **±0.1%~0.5%**——远高于 BTC 的 ±0.01% 和主流山寨的 ±0.05%。

#### OI 的庄家指纹

OI 变化在庄币中的含义取决于价格阶段：

- **OI 上升 + 价格不涨** = 庄家在合约市场开多建仓（最可靠的吸筹信号）
- **OI 上升 + 价格涨** = 庄家在加仓推高价格（趋势延续）
- **OI 下降 + 价格涨** = 庄家在平多单获利（危险——派发信号），但散户资金可能暂时接棒
- **OI 下降 + 价格跌** = 多头踩踏出逃（崩盘中继）
- **OI 骤增 + 价格脉冲** = 庄家突然介入，方向大概率持续

#### 成交量的庄家行为

- **放量突破横盘区间** = 庄家启动拉升
- **缩量上涨** = 市场上没有卖盘抵抗——拉升成本最低，庄家最爱的状态
- **放量滞涨** = 庄家在出货，散户在接盘——最危险的信号之一
- **天量后急缩** = 庄家已经完成了仓位调整，接下来是散户博弈

---

### 三、不逆庄原则

**这是庄币交易的第一铁律。**

1. **庄家出货时绝不抄底。** 底部由庄家决定，不由斐波那契决定。0.618 回撤位在庄币中只是心理安慰。
2. **庄家吸筹时绝不追空。** 庄家有无限资金，空头是庄家的对手盘。做空正在吸筹的庄币 = 把钱送给庄家。
3. **只在庄家行为有明确方向信号时入场。** 「方向不明确」在庄币中会要命——一旦站错边，庄家会确保你亏到怀疑人生。
4. **庄家洗盘时不要被吓出去。** 拉升中途的急跌急涨是洗盘，不是趋势反转。判断标准：OI 是否在急跌后快速恢复？如果是，庄家没走。

---

### 四、闪电战思维

庄币的最佳交易窗口往往很短——庄家不会给散户太多反应时间：

- **当信号出现时，执行要果断。** 不要等 4H 收盘确认——庄币用 15min K 线判断。
- **开仓后立即设好 OCO。** 没有「到时候再手动平」——等你看到的时候，行情已经走了 80%。
- **不做「动态调整」。** 庄币行情来去如风。设好止盈止损然后离开。频繁调整 = 过度干预 = 被庄家玩弄。

---

### 五、盈亏比哲学

庄币的盈亏比哲学：

- **方向对时利润可以非常大。** 庄家拉盘不按斐波那契——TP 目标应该更宽。
- **方向错时亏损明确。** 因为逻辑否定点（庄家行为被证伪）通常很快会到达——止损可以相对紧。
- **因此：以高盈亏比覆盖低胜率。**

> 硬性约束：庄币的**盈亏比必须 ≥ 1.5**。庄币行情不确定性更高，需要更高盈亏比弥补更低胜率。

---

## 报告结构

你的报告必须包含以下六个部分：

### 一、周期背景与历史回顾

- 该币种当前周期状态（新建周期 / 进行中）
- 历史报告中上次判断的庄家行为阶段是否应验？
- 上次开仓（如有）的结果如何？
- 从该币种的历史行为中提炼：这是第几波脉冲？庄家习惯用什么手法（稳步拉升/急拉急回/长时间横盘后暴拉）？
- 当前持仓状态

如果是首周期，简要说明「首周期，无历史报告」。

---

### 二、庄家行为阶段判定

基于三维数据，判断庄家当前处于哪个阶段：

**吸筹 / 拉升 / 派发 / 崩盘**

给出判断依据——每个阶段至少需要 3 个信号确认：
- 价格行为信号
- OI 变化信号
- 资金费率信号
- 成交量信号
- 链上筹码信号

**如果信号矛盾（如 OI 上升说不吸筹，但资金费率说派发），诚实说明矛盾，不要强行套阶段。**

---

### 三、三维叙事与庄家意图

从以下三个维度审视当前市场，**以「庄家想干什么」为唯一框架：**

**媒体面：** 当前市场在讲什么故事？这个故事是庄家花钱买来的（KOL 喊单、付费文章），还是自然的社区热度？当前市场情绪处于什么位置——怀疑、FOMO、还是绝望？庄家为什么选择在这个时间点推这个叙事？

**链上数据：** 筹码在集中还是分散？大地址在做什么？庄家的链上成本大约在哪？DEX 上的买卖模式揭示了什么——庄家在买入还是在卖出？

**合约技术面：** 价格行为确认了还是否定了上述推断？OI 和资金费率揭示了庄家什么操作？当前散户的仓位拥挤在哪一边？庄家下一个目标价位在哪——哪里可以击溃最多的对手盘？

**交叉审视：** 三条线索放在一起，你看到了什么？
- 消息面 + 链上 + 合约面，三者指向的庄家行为阶段是否一致？
- 如果矛盾，你认为哪个维度在当前阶段最可信？为什么？
- 有没有重要的盲区信号——某个维度本该有信号但完全没有？

---

### 四、闪电战策略

基于庄家行为阶段判断和庄家意图分析，给出：

#### 庄家下一步最可能的动作

别猜「市场会怎么走」——猜「庄家会怎么做」：
- 如果庄家在吸筹，他的下一步是继续横盘压低吸筹，还是准备启动？
- 如果庄家在拉升中，他的下一步是继续推高，还是该洗盘了？
- 如果庄家在派发，他还剩多少货？派发还能持续多久？
- **你预计庄家的下一步动作会在什么价位附近发生？**

#### 散户的处境

- 当前价格位置，散户的整体仓位偏向哪边？
- 什么价位会触发散户的止损/追单/恐慌？
- 庄家最可能利用哪个散户心理弱点？

#### 你的交易方向

- 站庄家哪一边？（顺势跟庄 / 逆势赌庄 / 观望）
- 为什么这不是「猜大小」而是有逻辑支撑的判断？
- 如果判断错误，最可能的原因是什么？

#### 行情已走多远？

在报告中给出本轮脉冲的数字画像：
- 本轮明确的启动点 / 横盘突破位是什么价位？
- 从该位置到当前价格，已完成了多少涨跌幅？耗时多久？
- 当前价格在庄家吸筹成本上方多少？

这些数字对判断剩余空间至关重要——庄家拉升的距离通常 > 吸筹区宽度的 2-3 倍。如果当前价格已经超过了这个距离，需要警惕派发。

---

### 五、开仓策略

**首先说明当前实盘持仓状态。**

**决策原则：**
- 吸筹确认 + 无持仓 → 择机做多，等待启动信号
- 拉升初中期 + 无持仓 → 立即跟进做多（闪电战）
- 拉升末期 + 已持仓 → 减仓或平仓
- 派发确认 → 平多，考虑做空
- 崩盘中 → 观望，不抄底
- 阶段判断模糊 → 观望，列出观察条件

**入场模式选择：**

入场模式选择：
- 🥇 **首选：等待庄家给出启动信号后跟进。** 一根放量突破横盘区间的大阳线 = 庄家宣誓。在突破位上方站稳 15min 后，立即市价入场。
- 🥈 **次选：吸筹期间埋伏，但不确定何时启动。** 如果吸筹信号明确但尚无启动信号，可以小仓位埋伏（正常仓位 50%），等启动信号加仓。
- ❌ **禁止：在派发阶段追多；在崩盘阶段抄底。**

**闪电战执行规则：**
- 开仓后必须在 5 分钟内设置好 OCO 止盈止损
- 不要等第二根 4H K 线确认——庄币不等人
- 入场用市价单，不等限价成交

---

## ⚙️ 止损位与仓位计算（开仓前必须执行）

### 计算流程

止损位和仓位通过 `scripts/calc-position.js` 自动计算。

**你需要提供以下输入：**

| 参数 | 说明 |
|------|------|
| `coin` | 币种代码 |
| `direction` | `long` 或 `short` |
| `entry` | 入场价格 |
| `x` | 波动乘数。庄币默认 **2.0**（最高档），极低流动性可上调至 2.2 |
| `levels` | 逗号分隔的技术位价格列表 |

**X 值选择——庄币专用指南：**

| X 值 | 适用场景 |
|------|---------|
| **2.0** | 庄币默认。庄币 ATR 通常较高，需要最大缓冲 |
| **2.1~2.2** | 极低流动性庄币（±2% 流动性 < $200K）、微价代币、链上筹码集中度 > 75% |
| **1.8** | 仅当该庄币近期波动相对温和、ATR < 8% 时 |

> 🚨 庄币不适用 X < 1.8。庄币的波动特性决定了窄止损极易被扫出。

技术位列表（`levels`）应从你的分析结论中提取：庄家吸筹区间的上/下沿、突破前的横盘区间、斐波那契关键位等。

### 执行命令

```bash
node scripts/calc-position.js \
  --coin {COIN} \
  --direction {long|short} \
  --entry {入场价} \
  --x {2.0-2.2} \
  --levels {技术位1},{技术位2},{技术位3},...
```

### 脚本内部逻辑

1. 获取 BTC 4H ATR(14) → `BTC_ATR%` → `BTC 基线 = BTC_ATR% × 1.5`
2. 获取山寨币 4H ATR(14) → `ALT_ATR%` → `原始止损% = ALT_ATR% × X`
3. 若 `原始止损% > 25%` → **REJECT**
4. 向**更远处**偏移到最近的技术位 → `最终止损价` & `最终止损%`
5. 若 `最终止损% > 25%` → **REJECT**
6. 仓位计算（线性）

---

**盈亏比计算（脚本输出最终止损后执行）：**

> 🚨 **硬性约束：庄币盈亏比必须 ≥ 1.5**。庄币行情不确定性更高，需要更高盈亏比弥补更低胜率。

**止盈规则：**
- 庄币推荐**一次性止盈**（不拆分）——因为庄币行情来去快，拆分止盈可能在 TP1 触发后行情就结束了
- 如果技术面有明确的二段目标（如派发区下沿 → 吸筹区下沿），可以阶段式止盈
- 止盈位以庄家行为目标为准：**吸筹区上方 2-3 倍区间宽度**（拉升目标）、**派发区下沿**（做空目标）

---

**无论观望还是开仓，你都必须要给出以下表格：**

| 项目 | 内容 |
|------|------|
| 操作类型 | 开仓 / 平仓 / 观望 |
| 方向 | 做多 / 做空（开仓时填写） |
| 庄家行为阶段 | 吸筹 / 拉升 / 派发 / 崩盘 |
| 入场位置 | $xxx（开仓时填写） |
| 入场条件 | 立即以当前价格入场 / 或在这里写明入场条件 |
| X 值 | X={2.0~2.2}，选择理由：xxx |
| 仓位 | {20~40}u 名义仓位（由脚本计算） |
| 止损 | $xxx | 幅度 xx%（脚本计算 + 技术位偏移结果）|
| 止损逻辑 | 基于脚本输出。逻辑否定点：庄家行为被证伪的条件（xxx），距入场 xx%，比值 = xx% / xx% = xx% |
| 止盈 | $xxx（庄家行为目标价位） |
| 盈亏比 | x.xx（≥ 1.5 才允许开仓） |
| 风险 | 高（庄币默认高风险） |

---

**如果不入场：**

明确列出观察条件——什么信号出现说明庄家进入了可交易的阶段？

可使用的观察条件（限制在合约数据面）：
- 价格突破/跌穿关键位（突破位、吸筹区上下沿）
- OI 变化超过阈值
- 资金费率进入极端区间
- Taker 买卖比出现明确方向
- 成交量异常放大/萎缩

---

### 六、数据来源

使用的本地数据路径：

| 数据维度 | 路径 |
|---------|------|
| 消息面 | `{CYCLE_DIR}/data-context/sentiment-media.md` |
| 链上数据 | `{CYCLE_DIR}/data-context/sentiment-onchain.md` |
| 合约技术 | `data/{COIN}-YYYY-MM-DD.json` |
| 历史报告 | 列出引用报告的路径 |
| 持仓文件 | `{CYCLE_DIR}/positions.json` |

---

⚠️ 报告末尾注明：仅供参考，不构成投资建议。七月-庄币版-v1.0。

---

**日志记录：**
```
[$NOW] [阶段二] 报告撰写完成
```

---

### 步骤 6: 保存报告文件

报告文件命名规则：
- 格式：`zhuang-report-{COIN}-YYYY-MM-DD-HHMM.md`
- 保存路径：`active/{CYCLE_DIR}/reports/zhuang-report-{COIN}-YYYY-MM-DD-HHMM.md`

**日志记录：**
```
[$NOW] [阶段二] 报告已保存: reports/zhuang-report-{COIN}-YYYY-MM-DD-HHMM.md
```

---



### 步骤 7: 输出开仓数据（JSON）

**⚠️ 必须执行。** 报告保存后，必须同时输出机器可读的结构化 JSON 文件，供阶段三脚本直接读取。

**文件命名规则：**
- 格式：`trade-decision-{COIN}-YYYY-MM-DD-HHMM.json`
- 保存路径：`active/{CYCLE_DIR}/reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json`

**JSON 结构（严格按此格式，不要增减字段）：**

```json
{
  "coin": "ONDO",
  "report_file": "zhuang-report-ONDO-2026-05-25-1500.md",
  "action": "open",
  "direction": "long",
  "zhuang_stage": "launch",
  "entry_condition": "immediate",
  "nominal_base": 30,
  "calc_position_input": {
    "entry": 0.15,
    "x": 2.0,
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
| `zhuang_stage` | string | 庄家行为阶段：`accumulation` / `launch` / `distribution` / `crash` |
| `entry_condition` | string | `immediate`（立即执行）或描述等待触发的条件 |
| `nominal_base` | number | 建议名义仓位（USDT），庄币默认 30 |
| `calc_position_input` | object | 传给 calc-position.js 的参数 `{entry, x, levels}` |
| `calc_position_output` | object/null | calc-position.js 的完整 JSON 输出（执行后填入） |
| `stop_loss` | number | 止损价位 |
| `take_profit1` | number | 止盈1价位 |
| `take_profit2` | number/null | 止盈2价位（可选） |
| `tp1_ratio` | number | TP1 平仓比例（默认 50）。庄币推荐 `100`（一次性） |
| `reject_reason` | string/null | 开仓被拒绝的原因（盈亏比不足/脚本REJECT等），null 表示允许 |
| `reduce_ratio` | number/null | 减仓比例（如 50），仅 action=reduce 时需要 |
| `observation_conditions` | string[] | 观望时列出的观察条件，只能使用合约数据面指标 |

**字段选择规则：**
- `action = open/add` → `direction`、`calc_position_input`、`stop_loss`、`take_profit1` 必填
- `action = reduce` → `reduce_ratio` 必填，**同时传入 `stop_loss`、`take_profit1`**（给剩余仓位用）
- `action = adjust` → `stop_loss`、`take_profit1` 填新价位
- `action = close` → 只需 `action: "close"`
- `action = hold` → `observation_conditions` 必填
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

### 步骤 8: 输出警报决策 JSON

这是阶段二的最后一份结构化产出，直接驱动阶段四脚本。你在此步骤中一次性完成：列出候选 → 检查现有规则 → 决定归档/创建 → 输出最终决策。

---

#### 8.1 检查现有活跃规则

```bash
ls skills/btc-alert/rules/{COIN}-*.js 2>/dev/null
```

对每个规则文件，读取其内容，了解：
- `ruleType` — `price-levels` / `oi-monitor` / `taker-ratio` / …
- `priceLevels` 或 `threshold` — 当前监控的价位或阈值
- `lifetime` — 是否已过期

---

#### 8.2 做决策

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
- 如果你不确定 ATR，保守做法：价位距当前价至少大于该币种 15m K 线的一根平均振幅。

保存 `active/{CYCLE_DIR}/reports/alert-candidates-{COIN}-YYYY-MM-DD-HHMM.json`：

```json
{
  "coin": "SOL",
  "cycle_id": "zhuang-SOL-20260525-0000",
  "report_path": "active/zhuang-SOL-20260525-0000/reports/zhuang-report-SOL-2026-05-25-0000.md",
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
        { "price": 85,   "type": "support",    "role": "key_support",   "label": "关键支撑",  "action": "跌破减仓", "priority": "medium",   "confirmPolicy": "hold" },
        { "price": 110,  "type": "resistance", "role": "key_resistance","label": "心理阻力",  "action": "接近观察", "priority": "low",      "confirmPolicy": "deep_hold" }
      ]
    },
    {
      "type": "oi-monitor",
      "mode": "pct",
      "threshold_value": 20,
      "direction": "above",
      "significance_template": "OI 24h 变化 {change_pct}%，超过 {threshold}% 阈值，OI 骤增"
    },
    {
      "type": "funding-reversal",
      "threshold_value": 0.01,
      "direction": "above",
      "significance_template": "资金费率 {funding_rate}%，突破 {threshold} 阈值，多头拥挤"
    }
  ]
}
```

**JSON 字段说明：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `coin` | string | 币种代码 |
| `cycle_id` | string | 当前周期目录名（如 `zhuang-ADA-20260525-1600`） |
| `report_path` | string | 本次报告完整路径（`active/.../zhuang-report-*.md`） |
| `has_position` | boolean | 当前是否持有该币种仓位 |
| `position_direction` | string/null | 持仓方向（`long`/`short`），无持仓为 `null` |
| `stability` | object | `max_retrace_pct`：回穿检测阈值（百分比，如 `0.3` = 0.3%）。庄币默认 **0.5%**（波动更大，回穿更频繁） |
| `archive_rules` | string[] | 需归档的规则文件名列表（可为空数组 `[]`） |
| `archive_reason` | string | 归档原因 |
| `create_rules` | object[] | 需创建的新规则列表。每个元素包含 `type` + 对应参数 |

**create_rules 中 `stability.max_retrace_pct` 按币种波动率缩放：**
- BTC：0.1%
- 大盘山寨币（ETH/SOL 级）：0.2%
- 中盘山寨币：0.3%
- 庄币（日波动 >20%）：**0.5%**

---

#### create_rules 各类型参数说明

#### `price-levels`

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | `"price-levels"` | 固定值 |
| `filename` | string | 生成的规则文件名，如 `{COIN}-price-levels.js` |
| `max_retrace_pct` | number | 回穿检测阈值。庄币默认 0.5 |
| `price_levels` | object[] | 价位列表，≤6 个 |

每个 `price_levels` 元素：

| 字段 | 类型 | 说明 |
|------|------|------|
| `price` | number | 监控价位 |
| `type` | `"support"` / `"resistance"` | 支撑位或阻力位 |
| `role` | string | 角色：`sl` / `tp1` / `tp2` / `entry_trigger` / `key_support` / `key_resistance` / `psychological` |
| `label` | string | 人类可读标签（中文） |
| `action` | string | 触发后建议执行的操作（中文） |
| `priority` | `"critical"` / `"high"` / `"medium"` / `"low"` | 优先级 |
| `confirmPolicy` | string | 确认策略：`instant`（SL）/ `touch`（TP）/ `hold`（入场触发/关键位）/ `deep_hold`（心理关口） |

#### `oi-monitor`

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | `"oi-monitor"` | 固定值 |
| `mode` | `"pct"` / `"abs"` | pct=百分比模式, abs=绝对值模式 |
| `threshold_value` | number | 阈值（pct模式为正数如20=20%, abs模式为整数张数） |
| `direction` | `"above"` / `"below"` | above=OI增幅≥阈值, below=OI降幅≥阈值 |
| `significance_template` | string | 触发时的中文描述模板，支持占位符 `{change_pct}`、`{threshold}` 等 |

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
echo "[$NOW] [阶段二] 警报决策数据已保存: reports/alert-candidates-{COIN}-YYYY-MM-DD-HHMM.json" >> logs/zhuang-${COIN}-process.log
```

---

### 步骤 9: 阶段二收尾

保存报告 + 输出两份 JSON 后，记录阶段二结束日志：

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段二] 报告已保存: reports/zhuang-report-{COIN}-YYYY-MM-DD-HHMM.md" >> logs/zhuang-${COIN}-process.log
echo "[$NOW] [阶段二] 开仓数据已保存: reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json" >> logs/zhuang-${COIN}-process.log
echo "[$NOW] [阶段二] 警报候选数据已保存: reports/alert-candidates-{COIN}-YYYY-MM-DD-HHMM.json" >> logs/zhuang-${COIN}-process.log
echo "[$NOW] [阶段二] ========== 阶段二结束 ==========" >> logs/zhuang-${COIN}-process.log
```

输出阶段二完成进度：

```
阶段二交叉验证分析已完成。
币种: {COIN}
周期目录: active/{CYCLE_DIR}
报告已保存: reports/zhuang-report-{COIN}-YYYY-MM-DD-HHMM.md
开仓数据已保存: reports/trade-decision-{COIN}-YYYY-MM-DD-HHMM.json
警报候选数据已保存: reports/alert-candidates-{COIN}-YYYY-MM-DD-HHMM.json
```

**⚠️ 收尾之后必须执行阶段三和阶段四脚本（详见下方「🔀 阶段交接」）。** 日志+输出完成不代表规则文件已生成——只有执行阶段三和阶段四脚本后，仓位和警报规则才会实际创建。

---

## 🔀 阶段交接

**⚠️ 阶段二完成后，你必须执行后续脚本。阶段二只负责分析和输出 JSON 文件，不执行脚本则仓位和规则均不会生效。**

### 分支 A：周期活跃 → 阶段三 → 阶段四

**执行阶段三和阶段四。**

#### A.1 执行阶段三——庄币专用（仓位管理）

```bash
node scripts/stage3-executor-zhuang.js {COIN} {CYCLE_DIR}
```

⚠️ 庄币使用 `stage3-executor-zhuang.js`（独立副本，预留庄币仓位倍率定制入口）。

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
4. **必须读历史报告**：分析前回顾该币种的庄家行为历史报告
5. **必须读持仓文件**：了解实盘持仓状态
6. **庄币分析核心：判断庄家行为阶段（吸筹/拉升/派发/崩盘）**，寻找叙事一致性
7. **不逆庄原则优先于一切技术分析**
8. **闪电战执行：信号确认后立即行动，不等多个时间框架**
9. **输出两份结构化 JSON**：`trade-decision.json`（阶段三输入，含 `zhuang_stage` 和 `calc_position_input`）+ `alert-candidates.json`（阶段四输入）
10. **专注撰写报告**：保存报告文件 + 两份 JSON，不修改其他文件
11. **必须执行阶段三和阶段四脚本**：在「🔀 阶段交接」章节中，先运行 `stage3-executor-zhuang.js`，根据 `pipeline_end` 标记决定是否接着运行 `stage4-executor.js`。切勿遗漏——仅输出 JSON 文件不会生成任何实际规则或仓位
12. **庄币盈亏比底线 ≥ 1.5**
13. **异常分级记录**：`⚠️ WARN` 不中断，`⛔ ERROR` 视情况处理

---

阶段二 - 庄币版 v1.0
