# 日报任务 - 阶段三：仓位管理

此任务为日报工作流的第三阶段，负责阅读报告、识别操作意图、执行仓位操作、同步持仓、判断归档。

---

## ⚠️ 日志强制要求

**任何涉及 OKX 实盘的仓位操作（下单/平仓/改单/取消）必须记录执行日志。**

| 操作 | 日志要求 | 缺失后果 |
|------|---------|---------|
| 开仓 | 成交后立即记录 | ❌ 无法追溯是否成交 |
| 加仓 | 成交后立即记录 | ❌ 无法确认加仓结果 |
| 减仓 | 成交后立即记录 | ❌ 无法确认减仓结果 |
| 平仓 | 成交后立即记录 | ❌ 无法确认平仓结果 |
| 设置/修改止盈止损 | 完成后立即记录 | ❌ 无法确认订单状态 |
| 跳过执行（等待触发） | 跳过时记录 | ❌ 无法追溯决策原因 |

**日志格式原则：每条操作日志必须包含「操作类型 + 结果 + 关键参数」，便于事后追溯。**

---

## 触发方式

- 由阶段二结束后触发
- 接收阶段二传递的日报文件路径

---

## 日志文件

**所有阶段共用同一个日报进程日志文件：**

路径：`logs/daily-report-process.log`

格式：追加模式，记录阶段三的开始、执行、结束、警告、错误。

**异常标识规则：**

| 级别 | 标识 | 含义 |
|------|------|------|
| **警告** | `⚠️ WARN` | 不影响流程继续执行 |
| **错误** | `⛔ ERROR` | 可能影响后续阶段，需关注 |

---

## 执行步骤

### 步骤 1: 记录阶段开始

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段三] 开始执行" >> logs/daily-report-process.log
```

---

### 步骤 2: 解析上一步消息或定位默认路径

**⚠️ 优先从上一步消息解析周期目录路径，从中推断日报和持仓文件路径。**

#### 2.1 从上一步消息解析参数

预期上一步消息格式：
```
阶段二分析已完成。
周期目录: active/cycle-YYYYMMDD-XXX
请读取 tasks/daily-report-stage3.md 开始阶段三仓位管理。
```

**提取周期目录路径，从中定位：**
- 日报文件：`${CYCLE_DIR}/reports/btc-report-*.md`（最新）
- 持仓文件：`${CYCLE_DIR}/positions.json`（固定位置）

#### 2.2 保底措施：从本地默认路径查找

**如果上一步消息解析失败，执行保底查找：**

```bash
# 直接查找最新周期目录
CYCLE_DIR=$(ls -td active/cycle-* 2>/dev/null | head -1)

# 从周期目录定位日报和持仓
REPORT_FILE=$(ls -t ${CYCLE_DIR}/reports/btc-report-*.md 2>/dev/null | head -1)
POSITIONS_FILE="${CYCLE_DIR}/positions.json"
```

**保底日志记录：**
```
[$NOW] [阶段三] ⚠️ WARN: 上一步消息解析失败，使用保底路径查找
[$NOW] [阶段三] 保底路径: 周期=${CYCLE_DIR}
```

#### 2.3 确认路径有效性

| 路径类型 | 来源 | 失败处理 |
|---------|------|---------|
| 周期目录 | 消息解析或保底查找 | ⛔ ERROR，无法继续 |
| 日报文件 | `${CYCLE_DIR}/reports/` | ⛔ ERROR，无法继续 |
| 持仓文件 | `${CYCLE_DIR}/positions.json` | ⚠️ WARN，假设无持仓 |

**日志记录：**
```
[$NOW] [阶段三] 周期目录: cycle-YYYYMMDD-XXX
[$NOW] [阶段三] 日报文件: reports/btc-report-YYYY-MM-DD-HHMM.md
[$NOW] [阶段三] 持仓文件: positions.json
```

---

### 步骤 3: 读取持仓文件

**读取实盘持仓状态：**

```bash
cat active/cycle-*/positions.json
```

**从中获取关键信息：**

| 信息 | 字段路径 | 用途 |
|------|---------|------|
| 是否有持仓 | `当前持仓数` | 决定可执行操作类型 |
| 持仓方向 | `当前持仓[].持仓方向` | 验证操作方向一致性 |
| 入场价 | `当前持仓[].平均入场价` | 加仓/减仓计算基准 |
| 持仓张数 | `当前持仓[].持仓张数` | 减仓/平仓数量计算 |
| 止盈止损 | `当前持仓[].委托订单` | 调整止盈止损时需取消 |
| 盈亏状态 | `当前持仓[].未实现盈亏` | 平仓决策参考 |

---

### 步骤 4: 识别操作意图

**阅读整篇日报，提炼仓位操作意图。**

你不是机械解析表格，而是作为分析师智能体，理解报告的分析逻辑和操作建议。

**提炼关键信息：**

| 信息 | 来源 | 说明 |
|------|------|------|
| **操作类型** | 报告整体判断 | 开仓/加仓/减仓/平仓/调整止盈止损/观望 |
| **操作方向** | 分析结论 | 做多/做空（开仓时） |
| **入场/操作价位** | 建议表格 | 具体价格数值 |
| **入场条件** | 建议表格 | 立即入场/等待触发 |
| **仓位比例** | 建议表格 | 如 "100%"、"50%" |
| **止盈价位** | 建议表格 | 分档止盈价格 |
| **止损价位** | 建议表格 | 止损价格 |
| **分析依据** | 报告正文 | 支撑该操作的逻辑和理由 |

**理解分析逻辑：**

日报的分析结论在多个部分体现：
- 「价格行为技术分析」→ 趋势判断、关键位置
- 「行情推断」→ 未来可能的走向
- 「仓位操作建议」→ 具体执行方案

你需要将分析逻辑和操作建议结合理解，而非孤立看待表格。

**日志记录：**
```
[$NOW] [阶段三] 操作意图识别: [操作类型] | 方向: [做多/做空/无] | 入场条件: [立即/等待触发]
```

---

### 步骤 5: 验证操作合理性

**根据持仓状态验证建议合理性：**

| 持仓状态 | 日报建议 | 验证结果 | 处理方式 |
|---------|---------|---------|---------|
| 无持仓 | 开仓 | ✓ 合理 | 执行开仓 |
| 无持仓 | 加仓 | ⚠️ 异常 | 转为开仓 |
| 无持仓 | 减仓/平仓 | ⚠️ 无仓位可操作 | 跳过执行，记录日志 |
| 有持仓（做多） | 开仓（做多） | ⚠️ 已有仓位 | 视为加仓 |
| 有持仓（做多） | 加仓（做多） | ✓ 合理 | 执行加仓 |
| 有持仓（做多） | 减仓 | ✓ 合理 | 执行减仓 |
| 有持仓（做多） | 平仓 | ✓ 合理 | 执行平仓 |
| 有持仓（做多） | 调整止盈止损 | ✓ 合理 | 执行调整 |
| 有持仓（做多） | 开仓（做空） | ⚠️ 方向冲突 | 需先平仓再反向开仓 |
| 有持仓 | 观望 | ✓ 合理 | 跳过执行 |

**冲突处理原则：**

- 方向冲突（做多持仓但建议做空）→ 记录警告，跳过执行
- 无仓位但建议减仓/平仓 → 记录警告，跳过执行
- 其他异常 → 记录警告，按合理方式调整

**日志记录：**
```
[$NOW] [阶段三] 操作验证: [✓合理/⚠️异常] | [异常时: 冲突原因]
```

---

### 步骤 6: 执行判断

**根据操作类型和入场条件判断是否执行：**

| 操作类型 | 入场条件 | 是否执行 |
|---------|---------|---------|
| 观望 | - | 跳过执行 |
| 开仓/加仓/减仓/平仓/调整 | 等待触发 | 跳过执行，记录等待条件 |
| 开仓/加仓/减仓/平仓/调整 | 立即入场 | 执行仓位操作 |

**立即执行时记录日志：**

```
[$NOW] [阶段三] 操作决策: [操作类型] | 条件: 立即执行 | 进入步骤7执行
```

**跳过执行时记录日志：**

```
[$NOW] [阶段三] 操作建议: [操作类型] | 状态: 跳过执行 | 原因: [观望/等待触发条件: xxx]
```

**设置止盈止损时记录日志：**

```
[$NOW] [阶段三] 操作决策: 调整止盈止损 | 条件: 无需入场条件 | 进入步骤7执行
```

---

### 步骤 7: 执行仓位操作

**如果需要执行，根据操作类型选择对应流程。**

---

#### 7.1 开仓流程

**安全限制（必须严格遵守）：**

| 限制项 | 值 | 说明 |
|--------|---|------|
| 默认杠杆 | 10x | **绝对不允许更改杠杆** |
| 仓位模式 | isolated（逐仓） | 必须使用逐仓模式 |
| 止损要求 | 必须 | 止损必须覆盖全部仓位 |
| 止盈要求 | 必须 | 分批止盈必须覆盖全部仓位（两档止盈合计100%） |

**执行步骤：**

##### 7.1.1 获取账户余额

```bash
okx-proxy.sh --profile live account balance USDT
```

记录 `equity`（权益）和 `available`（可用余额）。

**安全检查：**
- 计算所需保证金：`margin = NOMINAL_BASE / 3`（保守估计，对冲后 NOMINAL_FINAL 可能更大）
- 如果 `available < NOMINAL_BASE / 3`，**终止下单**，记录日志：
  ```
  [$NOW] [阶段三] ⛔ ERROR: 可用余额不足，需要 xx USDT，可用 xx USDT
  ```

##### 7.1.2 获取当前价格和合约信息

```bash
# 获取当前价格
okx-proxy.sh market ticker BTC-USDT-SWAP

# 获取合约信息
okx-proxy.sh market instruments --instType SWAP | grep BTC-USDT-SWAP
```

关键参数：
- `last`：最新成交价
- `ctVal`：合约面值（从 API 实时获取，如 BTC-USDT-SWAP=0.01 BTC）
- `minSz`：最小下单张数（⚠️ 从 API 实时获取，不同币种不同！如 BTC=0.01, ETH=0.01, SOL=0.1）
- `lotSz`：下单步长（⚠️ 从 API 实时获取，必须按此精度取整！如 BTC=0.01, 某些山寨币=1）

> 所有合约参数以 `market instruments` 实际返回值为准，不得硬编码。

##### 7.1.3 对冲调整

**在计算 sz 之前，先执行全账户对冲系数调整。**

**步骤 A：获取基础名义仓位**

```
# 阶段三步骤 4 中已从日报识别 NOMINAL_BASE
# NOMINAL_BASE = 日报表格「仓位」字段的数值，去除 u 后缀（如 300）
# 取值范围 [225, 450]
```

**步骤 B：执行对冲计算**

```bash
# 获取对冲系数 y（BTC 方向由日报的「方向」字段决定，long 或 short）
Y=$(bash scripts/calc-hedge-y.sh <long|short>)

# 计算最终名义仓位
NOMINAL_FINAL=$(python3 -c "print(round(${NOMINAL_BASE} * ${Y}, 2))")
```

**步骤 C：边界约束**

```
# 最终名义仓位不能超过 [100, 675] 区间
if NOMINAL_FINAL < 100:  NOMINAL_FINAL = 100
if NOMINAL_FINAL > 675:  NOMINAL_FINAL = 675
```

| 边界 | 值 | 理由 |
|------|---|------|
| 下限 | 100u | 过小仓位可能不够 1 张（100 / (80000×0.01) = 0.125 < 0.01 minSz） |
| 上限 | 675u | 450u × 1.5 = 675u，不超最大对冲系数 |

**步骤 D：记录对冲日志**

```
[$NOW] [阶段三] 对冲调整 | BTC方向={DIRECTION} |
全账户多头={LONG_NOM}u({LONG_RATIO}) 空头={SHORT_NOM}u({SHORT_RATIO}) |
y={Y} | 名义仓位 {NOMINAL_BASE}u→{NOMINAL_FINAL}u
```

> ⚠️ NOMINAL_FINAL 的计算参数从 `calc-hedge-y.js` 返回的 JSON 中提取（`y`、`long_nominal`、`short_nominal`、`long_ratio`、`short_ratio`）。

##### 7.1.4 计算下单参数

| 参数 | 来源 | 计算方式 |
|------|------|---------|
| instId | 固定 | BTC-USDT-SWAP |
| side | 建议 | direction: long → buy, short → sell |
| sz | 计算 | NOMINAL_FINAL / (价格 × ctVal)，按 lotSz 步进取整 |
| tdMode | 固定 | isolated |
| posSide | 建议 | direction: long → long, short → short |

**示例计算（NOMINAL_FINAL 为对冲调整后的最终名义仓位）：**

```
例A：NOMINAL_BASE=300u, y=1.312 → NOMINAL_FINAL=394u, price=$80,000, ctVal=0.01
  sz = 394 / (80000 × 0.01) = 0.4925 → 取整到 lotSz(0.01) = 0.49 张
  名义价值 = 0.49 × 80000 × 0.01 = 392 USDT ✅

例B：NOMINAL_BASE=300u, y=0.688 → NOMINAL_FINAL=206u, price=$80,000, ctVal=0.01
  sz = 206 / (80000 × 0.01) = 0.2575 → 取整到 lotSz(0.01) = 0.25 张
  名义价值 = 0.25 × 80000 × 0.01 = 200 USDT ✅

例C：NOMINAL_BASE=400u, y=1.5 → NOMINAL_FINAL=600u
  sz = 600 / (80000 × 0.01) = 0.75 张
  名义价值 = 0.75 × 80000 × 0.01 = 600 USDT ✅
```

**NOMINAL_BASE 来源**：阶段三步骤 4 从日报表格「仓位」字段识别（如 300u、400u），范围 [225, 450]。

** ⚠️ 最小仓位检查（必须用实际 minSz 而非固定值！）：**

```bash
# 从合约信息中获取实际的 minSz（不同币种不同！）
# 如 BTC-USDT-SWAP 的 minSz=0.01, lotSz=0.01
```

- 计算张数 `sz = NOMINAL_FINAL / (价格 × ctVal)`，按 `lotSz` 步进取整
- 如果 `sz < minSz`，**终止下单**，记录日志：
  ```
  [$NOW] [阶段三] ⛔ ERROR: 计算张数 {sz} < 最小下单张数 {minSz}（合约：{instId}）
  名义仓位 {NOMINAL_FINAL}u 不足以开最小张数
  ```
- **即使 sz ≥ minSz，如果取整后值不是 lotSz 的整数倍，也需修正为合法值**

##### 7.1.5 执行下单

```bash
okx-proxy.sh --profile live swap place \
  --instId BTC-USDT-SWAP \
  --side <buy|sell> \
  --ordType market \
  --sz <张数> \
  --tdMode isolated \
  --posSide <long|short>
```

**注意：** 不传递 `--lever` 参数，保持账户默认杠杆设置（应为 3x）。

**下单结果处理：**
- 成功：记录订单ID `ordId`，平均成交价 `avgPx`
- 失败：记录错误信息，终止执行

##### 7.1.6 等待成交确认

下单后等待 2 秒，然后查询持仓确认成交：

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP --tdMode isolated
```

记录：
- `avgPx`：平均成交价（作为实际入场价）
- `pos`：持仓张数

##### 7.1.7 设置止盈止损

⚠️ **必须创建止盈止损订单！**

根据日报建议的止盈止损价位设置 OCO 订单。

**止盈止损分配规则：**

假设建议有 `take_profit: [tp1, tp2]` 和 `stop_loss: sl`，仓位为 `sz` 张：

| 订单 | 类型 | 张数 | 触发价 | 说明 |
|------|------|------|--------|------|
| TP1 | OCO | sz/2 | tp1 | 第一档止盈，平仓 50% |
| TP2 | OCO | sz/2 | tp2 | 第二档止盈，平仓剩余 50% |
| SL | OCO | sz | sl | 止损，平仓全部 |

**⭐ 盈亏比偏移规则（止盈 + 止损）：**

⚠️ **强制规则：止盈和止损都必须应用偏移，不得省略！**

**核心思想**：不以"价格是否为整数"作为偏移依据，而是以**盈亏距离百分比**计算偏移量。所有币种统一适用。

**配置（在 7.1.6 开头设置）：**

| 参数 | BTC 默认值 | 说明 |
|------|-----------|------|
| `TP_SHIFT_PCT` | 5 | 止盈让利%，放弃 5% 利润换更易触发 |
| `SL_SHIFT_PCT` | 5 | 止损多扛%，多承受 5% 亏损换更难触发 |
| `MAX_SHIFT_PCT` | 20 | 偏移上限，不超过原距离的 20% |
| `TICK` | 0.1 | 最小价格单位（BTC-USDT-SWAP = 0.1） |

**公式：**

```
原距离 D = |入场价 - 目标价|

止盈新距离 = D × (1 - TP_SHIFT_PCT/100)   ← 放弃利润，止盈更近更易触
止损新距离 = D × (1 + SL_SHIFT_PCT/100)   ← 多扛亏损，止损更远更难触

约束：新距离 ∈ [TICK, D × (1 + MAX_SHIFT_PCT/100)]
```

**折算为价格：**

| 方向 | 止盈新价 | 止损新价 |
|------|---------|---------|
| 做多 | 入场 + 止盈新距离 | 入场 − 止损新距离 |
| 做空 | 入场 − 止盈新距离 | 入场 + 止损新距离 |

**安全约束（必须）：**
- 止盈不得越过入场价：做多止盈 > 入场价，做空止盈 < 入场价
- 偏移后价格取整到 TICK 精度

**参考实现（每次设置止盈止损前必须执行）：**

```
function calc_pnl_offset(entry, target, type, direction):
    // 配置
    tp_pct = 5       // 止盈让利比
    sl_pct = 5       // 止损多扛比
    max_pct = 20     // 偏移上限
    tick = 0.1       // BTC 最小单位
    
    // 1. 原距离
    orig_dist = abs(target - entry)
    
    // 2. 选择偏移百分比
    shift_pct = (type == "tp") ? tp_pct : sl_pct
    
    // 3. 新距离
    if type == "tp":
        new_dist = orig_dist × (1 - shift_pct/100)
    else:  // sl
        new_dist = orig_dist × (1 + shift_pct/100)
    
    // 4. 约束
    new_dist = max(new_dist, tick)                  // 下限 ≥ 1 tick
    new_dist = min(new_dist, orig_dist × 1.20)      // 上限 ≤ 120%
    
    // 5. 折算价格
    if direction == "long":
        new_price = (type == "tp") ? entry + new_dist : entry - new_dist
    else:  // short
        new_price = (type == "tp") ? entry - new_dist : entry + new_dist
    
    // 6. 穿透检查：止盈不得越过入场价
    if type == "tp" and direction == "long" and new_price <= entry:
        new_price = entry + tick
    if type == "tp" and direction == "short" and new_price >= entry:
        new_price = entry - tick
    
    // 7. 取整到 tick
    new_price = round(new_price / tick) × tick
    
    return new_price

// 调用示例
TP1_ACTUAL = calc_pnl_offset(ENTRY, TP1_RAW, "tp", DIR)
TP2_ACTUAL = calc_pnl_offset(ENTRY, TP2_RAW, "tp", DIR)
SL_ACTUAL  = calc_pnl_offset(ENTRY, SL_RAW,  "sl", DIR)

// 日志
log("⭐ 盈亏比偏移 | 入场=$ENTRY | TP1: $TP1_RAW→$TP1_ACTUAL | TP2: $TP2_RAW→$TP2_ACTUAL | SL: $SL_RAW→$SL_ACTUAL | tp%=$tp_pct sl%=$sl_pct")
```

**⚠️ 重要提醒：**
- 报告给出的止盈/止损价格是**分析判断的理想位置**，**不是**实际挂单价格
- 偏移是**必须执行的规则**，不是可选优化
- 偏移目的：止盈更易触发（放弃少量利润），止损更难触发（多扛少量亏损）
- 所有价位都会偏移，不再判断"是否整数"

**执行命令（使用已计算的偏移后价格）：**

```bash
# 第一档止盈（sz/2 张）
okx-proxy.sh --profile live swap algo place \
  --instId BTC-USDT-SWAP \
  --side <sell|buy> \
  --sz <sz/2> \
  --tdMode isolated \
  --posSide <long|short> \
  --reduceOnly \
  --ordType oco \
  --tpTriggerPx <$TP1_ACTUAL> \
  --tpOrdPx=-1 \
  --slTriggerPx <$SL_ACTUAL> \
  --slOrdPx=-1

# 第二档止盈（sz/2 张）
okx-proxy.sh --profile live swap algo place \
  --instId BTC-USDT-SWAP \
  --side <sell|buy> \
  --sz <sz/2> \
  --tdMode isolated \
  --posSide <long|short> \
  --reduceOnly \
  --ordType oco \
  --tpTriggerPx <$TP2_ACTUAL> \
  --tpOrdPx=-1 \
  --slTriggerPx <$SL_ACTUAL> \
  --slOrdPx=-1
```

**⚠️ 挂单价格必须使用 `$TP1_ACTUAL` / `$TP2_ACTUAL` / `$SL_ACTUAL`，禁止直接使用报告原始值！**

**注意方向：**
- 做多平仓：`--side sell`
- 做空平仓：`--side buy`

##### 7.1.8 核对结果

**核对持仓：**

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP --tdMode isolated
```

核对项目：
- 持仓方向是否正确
- 持仓张数是否接近预期（允许 ±1 张误差）
- 持仓均价是否在入场区间内

**核对止盈止损：**

```bash
okx-proxy.sh --profile live swap algo orders --instId BTC-USDT-SWAP --tdMode isolated
```

核对项目：
- 止盈订单数量应为 2（两档止盈）
- 止盈触发价是否正确
- 止损触发价是否正确
- 所有订单状态应为 `live`

**核对账户余额：**

```bash
okx-proxy.sh --profile live account balance USDT
```

核对项目：
- 余额扣除是否合理（保证金 + 手续费）
- 冻结金额是否正确

**记录执行日志：**

```
[$NOW] [阶段三] 开仓成功 | 方向: long/short | 张数: xx | 成交价: xx | 止盈: [${TP1_ACTUAL}, ${TP2_ACTUAL}]（已偏移） | 止损: ${SL_ACTUAL}（已偏移） | 订单ID: xx | 止盈止损ID: [xx, xx]
```

---

#### 7.2 加仓流程

**加仓前提：当前已有持仓**

**执行步骤：**

##### 7.2.1 获取当前持仓信息

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP --tdMode isolated
```

记录：
- 当前持仓张数 `pos`
- 平均入场价 `avgPx`
- 持仓方向 `posSide`

##### 7.2.2 获取账户余额

```bash
okx-proxy.sh --profile live account balance USDT
```

##### 7.2.3 计算加仓张数

使用与开仓相同的逻辑：
- **先执行对冲调整**：`NOMINAL_FINAL = NOMINAL_BASE × Y`（同 7.1.3，Y 由 `calc-hedge-y.sh` 获取）
- `sz_add = NOMINAL_FINAL / (价格 × ctVal)`，按 `lotSz` 步进取整
- 同样执行 `sz_add ≥ minSz` 检查

##### 7.2.4 执行加仓下单

```bash
okx-proxy.sh --profile live swap place \
  --instId BTC-USDT-SWAP \
  --side <buy|sell> \
  --ordType market \
  --sz <sz_add> \
  --tdMode isolated \
  --posSide <long|short>
```

**记录执行日志：**

```
[$NOW] [阶段三] 加仓成功 | 方向: long/short | 加仓张数: xx | 成交价: xx | 订单ID: xx
```

##### 7.2.5 更新止盈止损

⚠️ **加仓后必须重新设置止盈止损，覆盖全部仓位！**

**新总仓位 = 原仓位 + 加仓张数**

取消旧止盈止损订单：
```bash
okx-proxy.sh --profile live swap algo cancel --instId BTC-USDT-SWAP --algoId <旧algoId>
```

设置新的止盈止损（覆盖全部新仓位）：
- ⚠️ **必须重新计算偏移量**（调用 `calc_pnl_offset()`，与 7.1.6 完全相同）
- 记录偏移日志
- 使用偏移后价格设置订单
- 两档止盈各覆盖新总仓位的 50%
- 止损覆盖新总仓位全部

##### 7.2.6 核对结果

与开仓流程相同。

**核对完成后记录汇总日志：**

```
[$NOW] [阶段三] 加仓流程完成 | 新总仓位: xx 张 | 止盈止损: [${TP1_ACTUAL}, ${TP2_ACTUAL}]（已偏移） | 止损: ${SL_ACTUAL}（已偏移） | 状态: 已更新
```

---

#### 7.3 减仓流程

**减仓前提：当前已有持仓**

**执行步骤：**

##### 7.3.1 获取当前持仓信息

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP --tdMode isolated
```

##### 7.3.2 计算减仓张数

根据日报建议的减仓比例：
- `sz_reduce = 当前持仓张数 × 减仓比例`
- 或直接按建议张数减仓

##### 7.3.3 执行部分平仓

⚠️ **重要：不能用 `swap close`！** `swap close` 会关闭**全部**仓位，无论是否指定 `--sz`。

**减仓的正确方式：用 `swap place` 反向市价单（仓位模式下会减少同方向仓位）**

```bash
# ⚠️ 安全前提：sz_reduce 必须 < 当前持仓张数
okx-proxy.sh --profile live swap place \
  --instId BTC-USDT-SWAP \
  --side <sell|buy> \
  --ordType market \
  --sz <sz_reduce> \
  --tdMode isolated \
  --posSide <long|short>
```

**方向规则：**
- 做多减仓：`--side sell --posSide long`
- 做空减仓：`--side buy --posSide short`

**安全验证（下单前必须执行）：**
```bash
# 从持仓文件读取当前持仓张数
CURRENT_POS=$(node -e "const p=require('./<cycle_dir>/positions.json'); console.log(p.当前持仓[0].持仓张数)")

# 验证减仓张数不超过当前持仓
if [ "$(echo "$sz_reduce >= $CURRENT_POS" | bc)" -eq 1 ]; then
  echo "[$NOW] [阶段三] ⛔ ERROR: 减仓张数($sz_reduce) >= 当前持仓($CURRENT_POS)，应使用平仓流程而非减仓" >> logs/daily-report-process.log
  exit 1
fi
```

**记录执行日志：**

```
[$NOW] [阶段三] 减仓成功 | 方向: long/short | 减仓张数: xx | 剩余仓位: (当前持仓-减仓) 张
```

##### 7.3.4 更新止盈止损

⚠️ **减仓后必须重新设置止盈止损，覆盖剩余仓位！**

**剩余仓位 = 原仓位 - 减仓张数**

取消旧止盈止损订单，设置新订单覆盖剩余仓位。

⚠️ **必须重新计算偏移量**（调用 `calc_pnl_offset()`，与 7.1.6 完全相同），记录偏移日志。

##### 7.3.5 核对结果

确认剩余持仓张数正确，止盈止损覆盖全部剩余仓位。

**核对完成后记录汇总日志：**

```
[$NOW] [阶段三] 减仓流程完成 | 剩余仓位: xx 张 | 止盈止损: [${TP1_ACTUAL}, ${TP2_ACTUAL}]（已偏移） | 止损: ${SL_ACTUAL}（已偏移） | 状态: 已更新
```

---

#### 7.4 平仓流程

**平仓前提：当前已有持仓**

**执行步骤：**

##### 7.4.1 取消止盈止损订单

```bash
okx-proxy.sh --profile live swap algo cancel-all --instId BTC-USDT-SWAP
```

或逐个取消：
```bash
okx-proxy.sh --profile live swap algo cancel --instId BTC-USDT-SWAP --algoId <algoId>
```

##### 7.4.2 执行全部平仓

⚠️ **注意：`swap close` 不使用 `--tdMode`，使用 `--mgnMode`。不指定 `--sz`，会关闭全部仓位。**

```bash
okx-proxy.sh --profile live swap close \
  --instId BTC-USDT-SWAP \
  --mgnMode isolated \
  --posSide <long|short>
```

##### 7.4.3 等待成交确认

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP --tdMode isolated
```

确认持仓张数为 0。

**记录执行日志：**

```
[$NOW] [阶段三] 平仓成功 | 方向: long/short | 平仓张数: xx | 平仓价: xx | 盈亏: xx USDT
```

---

#### 7.5 调整止盈止损流程

**前提：当前已有持仓和止盈止损订单**

**执行步骤：**

##### 7.5.1 获取当前止盈止损订单

```bash
okx-proxy.sh --profile live swap algo orders --instId BTC-USDT-SWAP --tdMode isolated
```

记录所有 algoId。

##### 7.5.2 取消旧订单

```bash
okx-proxy.sh --profile live swap algo cancel-all --instId BTC-USDT-SWAP
```

或逐个取消。

##### 7.5.3 设置新止盈止损

⚠️ **必须应用盈亏比偏移规则！** 根据日报建议的新价位，**调用 `calc_pnl_offset()`**（与 7.1.6 完全相同），再设置订单。

执行步骤：
1. 调用 `calc_pnl_offset(entry, tp1, "tp", dir)` → $TP1_ACTUAL
2. 调用 `calc_pnl_offset(entry, tp2, "tp", dir)` → $TP2_ACTUAL
3. 调用 `calc_pnl_offset(entry, sl,  "sl", dir)` → $SL_ACTUAL
4. 记录偏移日志，使用偏移后价格设置止盈止损订单

**记录执行日志：**

```
[$NOW] [阶段三] 止盈止损更新 | 止盈1: [${TP1_RAW}→${TP1_ACTUAL}, sz/2] | 止盈2: [${TP2_RAW}→${TP2_ACTUAL}, sz/2] | 止损: [${SL_RAW}→${SL_ACTUAL}, sz] | 订单ID: [tp1Id, tp2Id, slId]
```

##### 7.5.4 核对结果

确认新订单状态为 `live`，触发价正确。

**核对完成后记录汇总日志：**

```
[$NOW] [阶段三] 调整止盈止损完成 | 止盈: [${TP1_ACTUAL}, ${TP2_ACTUAL}]（已偏移） | 止损: ${SL_ACTUAL}（已偏移） | 状态: 已更新
```

---

### 步骤 8: 同步持仓文件

**执行仓位操作后，必须同步持仓文件。**

**路由调用 sync-positions.md：**

读取 `tasks/sync-positions.md`，按其步骤执行持仓同步。

sync-positions.md 会完成以下操作：
- 从 OKX API 获取最新持仓、止盈止损订单、账单记录
- 筛选 BTC-USDT-SWAP 逐仓仓位
- 检测平仓状态（对比旧持仓文件，填充「最近平仓」字段）
- 覆写 `positions.json`

**记录日志：**

```
[$NOW] [阶段三] 持仓文件已同步: 当前持仓 X 个 | 最近平仓: 有/无
```

---

### 步骤 9: 判断归档

**根据持仓文件判断是否归档周期。**

##### 9.1 检查归档条件

**归档条件（同时满足）：**

| 条件 | 检查方式 |
|------|---------|
| 当前持仓数 = 0 | `positions.json` → `汇总.当前持仓数 === 0` |
| 最近平仓非空 | `positions.json` → `最近平仓 !== null` |

**两个条件同时满足 → 执行归档**

##### 9.2 执行归档

**归档操作（统一脚本三步骤：实盘盈亏同步 → 规则归档 → 目录移动）：**

```bash
# 使用统一归档脚本，一次性完成三步骤
node scripts/archive-cycle.js --cycle cycle-YYYYMMDD-XXX

# 脚本自动执行：
#   步骤1: 调用 OKX positions-history API → 同步实盘平仓盈亏 → 更新 positions.json
#   步骤2: 调用 archive-rules.js --cycle xxx --by cycle-archived 归档所有关联规则
#   步骤3: mv active/xxx archived/
#   输出: 盈亏摘要
#
# 可选参数：
#   --by manual        自定义归档来源（默认 cycle-archived）
#   --reason "xxx"      自定义归档原因
#   --close-type "止损触发"  覆盖平仓类型
```

**脚本路径**：`scripts/archive-cycle.js`

**⚠️ 重要**：统一脚本已将规则归档。阶段四触发时，分支 A 的 A.1-A.3（规则清零部分）应检测到无活跃规则并跳过，但仍需执行 A.4（创建复盘 cron）。

**执行后记录归档信息：**

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段三] 周期归档 | cycle-xxx → archived/ | 使用 archive-cycle.js 统一归档" >> logs/daily-report-process.log
```

##### 9.3 不满足归档条件

周期继续，记录状态：

```
[$NOW] [阶段三] 周期继续 | 当前持仓: X 个 | 状态: active
```

---

### 步骤 10: 记录阶段结束

阶段三仓位管理完成。输出当前进度和周期状态。

**步骤 10.1：记录进度**

在回复中输出：

```
阶段三仓位管理已完成。
周期状态: [所有仓位平仓，已完成归档/周期活跃中]
周期路径: [archived/cycle-xxx | active/cycle-xxx]
```

**步骤 10.2：记录日志****

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段三] ========== 阶段三结束 ========== " >> logs/daily-report-process.log
```

---

## 异常处理

### 下单失败

1. 记录日志：`[$NOW] [阶段三] ⛔ ERROR: 下单失败 - [错误信息]`
2. 不继续后续步骤（止盈止损设置等）
3. 同步持仓文件（确认状态）
4. 继续流程（进入阶段四）

### 止盈止损设置失败

1. 记录日志：`[$NOW] [阶段三] ⛔ ERROR: 止盈止损设置失败 - [错误信息]`
2. 尝试重新设置（最多 3 次）
3. 如仍失败，记录异常日志，同步持仓文件后继续流程

### 余额不足

1. 记录日志：`[$NOW] [阶段三] ⚠️ WARN: 可用余额不足，需要 xx USDT，可用 xx USDT`
2. 跳过下单
3. 同步持仓文件后继续流程

### 仓位低于最小张数

1. 记录日志：`[$NOW] [阶段三] ⚠️ WARN: 计算仓位低于最小张数，需要 equity ≥ xxx USDT`
2. 跳过下单
3. 同步持仓文件后继续流程

### 持仓同步失败

1. 记录日志：`[$NOW] [阶段三] ⛔ ERROR: 持仓同步失败 - [错误信息]`
2. 继续流程（归档判断可能受影响，标记「无法判断」）

### 归档失败

1. 记录日志：`[$NOW] [阶段三] ⛔ ERROR: 归档失败 - [错误信息]`
2. 不移动文件夹
3. 继续流程，等待下次执行时重试

---

## 核心要求

1. **⭐ 优先解析上一步消息获取日报路径**：从阶段二结束后传递的消息中获取日报路径
2. **保底措施必须执行**：上一步消息解析失败时，从本地默认路径查找日报
3. **阅读整篇日报**：理解分析逻辑，提炼仓位意图（阶段三本职工作）
4. **必须读持仓文件**：验证建议合理性
5. **操作必须明确**：立即入场才执行，等待触发跳过
6. **安全限制不变**：杠杆 3x、逐仓、止盈止损必须覆盖全部
7. **执行后必须同步持仓**：调用 sync-positions 逻辑更新文件
8. **归档判断基于「最近平仓」**：观察持仓文件字段
9. **⭐ 上一步消息传递周期状态**：供阶段四决定清零还是正常管理
10. **完成后继续阶段四**：输出周期状态和路径，然后读取 tasks/daily-report-stage4.md 继续执行
11. **异常分级记录**：`⚠️ WARN` 不中断，`⛔ ERROR` 视情况处理
12. **日志完整记录**：每个关键步骤都有日志

---

## 阶段过渡

输出周期状态和路径后，立即读取并执行 `tasks/daily-report-stage4.md`。

---

阶段三-v4.21（完整版）

---

## v4.21 变更记录 (2026-05-11)

### 盈亏比偏移重构（替代整数位偏移）
- **废弃**: 基于价格字符串格式的整数位判断（末2位00、固定22点）
- **新方案**: 基于盈亏距离百分比的统一偏移函数 `calc_pnl_offset()`
- **公式**: 止盈新距离 = D×(1−5%), 止损新距离 = D×(1+5%)
- **约束**: 下限 ≥ 1 tick, 上限 ≤ D×120%
- **穿透检查**: 止盈不得越过入场价
- **配置**: TP_SHIFT_PCT=5, SL_SHIFT_PCT=5, MAX_SHIFT_PCT=20, TICK=0.1
- **适用**: 所有价位均偏移，不再判断"是否整数"

## v4.20 变更记录 (2026-05-11) — 已被 v4.21 替代

### 整数位偏移逻辑修复
- **Bug 修复**: 原判断代码 `末3位=000` 仅覆盖千位整数（如 82000），遗漏百位整数关口（如 82500、80500）
- **修正为**: 检查末 2 位 `00`，同时覆盖百位和千位整数关口
- **新增**: `calc_offset()` 统一函数，替代散落的重复判断代码
- **日志增强**: 偏移日志增加「末2位」信息，即使无偏移也记录原因