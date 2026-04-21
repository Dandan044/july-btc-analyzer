# 日报任务 - 阶段三：仓位管理

此任务为日报工作流的第三阶段，负责阅读报告、识别操作意图、执行仓位操作、同步持仓、判断归档。

---

## 触发方式

- 由阶段二 spawn 触发
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

### 步骤 2: 解析 Spawn 消息或定位默认路径

**⚠️ 优先从 spawn 消息解析周期目录路径，从中推断日报和持仓文件路径。**

#### 2.1 从 Spawn 消息解析参数

预期 Spawn 消息格式：
```
阶段二分析已完成。
周期目录: active/cycle-YYYYMMDD-XXX
请读取 tasks/daily-report-stage3.md 开始阶段三仓位管理。
```

**提取周期目录路径，从中定位：**
- 日报文件：`${CYCLE_DIR}/reports/btc-report-*.md`（最新）
- 持仓文件：`${CYCLE_DIR}/positions.json`（固定位置）

#### 2.2 保底措施：从本地默认路径查找

**如果 spawn 消息解析失败，执行保底查找：**

```bash
# 直接查找最新周期目录
CYCLE_DIR=$(ls -td active/cycle-* 2>/dev/null | head -1)

# 从周期目录定位日报和持仓
REPORT_FILE=$(ls -t ${CYCLE_DIR}/reports/btc-report-*.md 2>/dev/null | head -1)
POSITIONS_FILE="${CYCLE_DIR}/positions.json"
```

**保底日志记录：**
```
[$NOW] [阶段三] ⚠️ WARN: Spawn 消息解析失败，使用保底路径查找
[$NOW] [阶段三] 保底路径: 周期=${CYCLE_DIR}
```

#### 2.3 确认路径有效性

| 路径类型 | 来源 | 失败处理 |
|---------|------|---------|
| 周期目录 | spawn解析或保底查找 | ⛔ ERROR，无法继续 |
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
| 设置止盈止损 | - | 执行（无需入场条件） |

**跳过执行时记录日志：**

```
[$NOW] [阶段三] 操作建议: [操作类型] | 状态: 跳过执行 | 原因: [观望/等待触发条件: xxx]
```

---

### 步骤 7: 执行仓位操作

**如果需要执行，根据操作类型选择对应流程。**

---

#### 7.1 开仓流程

**安全限制（必须严格遵守）：**

| 限制项 | 值 | 说明 |
|--------|---|------|
| 默认杠杆 | 3x | **绝对不允许更改杠杆** |
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
- 计算所需保证金：`margin = equity × position_size / leverage`
- 如果 `available < margin`，**终止下单**，记录日志：
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
- `ctVal`：合约面值（BTC-USDT-SWAP 为 0.01 BTC）
- `minSz`：最小下单张数
- `lotSz`：下单步长

##### 7.1.3 计算下单参数

| 参数 | 来源 | 计算方式 |
|------|------|---------|
| instId | 固定 | BTC-USDT-SWAP |
| side | 建议 | direction: long → buy, short → sell |
| sz | 计算 | equity × position_size / (价格 × ctVal)，向下取整到 lotSz |
| tdMode | 固定 | isolated |
| posSide | 建议 | direction: long → long, short → short |

**示例计算（position_size 表示名义价值相对于余额的比例）：**

```
例A：position_size = 100%（标准仓位）
equity = 500 USDT
名义价值 = 500 × 100% = 500 USDT
保证金 = 500 / 3 = 166.67 USDT
张数 = 500 / (76000 × 0.01) = 0.657 张

例B：position_size = 200%（2倍仓位）
equity = 500 USDT
名义价值 = 500 × 200% = 1000 USDT
保证金 = 1000 / 3 = 333.33 USDT
张数 = 1000 / (76000 × 0.01) = 1.31 张

例C：position_size = 300%（3倍仓位，最大）
equity = 500 USDT
名义价值 = 500 × 300% = 1500 USDT
保证金 = 1500 / 3 = 500 USDT（需要全部余额）
张数 = 1500 / (76000 × 0.01) = 1.97 张
```

**position_size 范围：75%~300%**
- 75% = 名义价值为余额的 75%
- 100% = 名义价值等于余额
- 200% = 名义价值为余额的 2倍
- 300% = 名义价值为余额的 3倍（最大，需要全部可用余额作为保证金）

**最小仓位检查：**
- BTC-USDT-SWAP 合约信息：`ctVal = 0.01 BTC`，`minSz = 0.01张`，`lotSz = 0.01张`
- 计算张数 `sz = equity × position_size / (价格 × ctVal)`，向下取整到 `lotSz`
- 如果 `sz < minSz`（即 `sz < 0.01张`），**终止下单**，记录日志：
  ```
  [$NOW] [阶段三] ⛔ ERROR: 账户权益不足以开立最小仓位（equity × position_size < 价格 × minSz × ctVal）
  需要 equity ≥ xxx USDT，当前 equity = xxx USDT
  ```

##### 7.1.4 执行下单

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

##### 7.1.5 等待成交确认

下单后等待 2 秒，然后查询持仓确认成交：

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP
```

记录：
- `avgPx`：平均成交价（作为实际入场价）
- `pos`：持仓张数

##### 7.1.6 设置止盈止损

⚠️ **必须创建止盈止损订单！**

根据日报建议的止盈止损价位设置 OCO 订单。

**止盈止损分配规则：**

假设建议有 `take_profit: [tp1, tp2]` 和 `stop_loss: sl`，仓位为 `sz` 张：

| 订单 | 类型 | 张数 | 触发价 | 说明 |
|------|------|------|--------|------|
| TP1 | OCO | sz/2 | tp1 | 第一档止盈，平仓 50% |
| TP2 | OCO | sz/2 | tp2 | 第二档止盈，平仓剩余 50% |
| SL | OCO | sz | sl | 止损，平仓全部 |

**⭐ 整数位偏移规则（止盈专用）：**

整数价位（如 72000、75000）常有强大阻力，价格可能差一点不到。设置止盈时需酌情偏移：

| 方向 | 原止盈价 | 实际设置 | 示例 |
|------|---------|---------|------|
| 多单 | 72500 | 72500 - 22 = **72478** | 略低，更容易触发 |
| 空单 | 72500 | 72500 + 22 = **72522** | 略高，更容易触发 |

**判断逻辑：**
- 如果止盈价是整数（末尾 2-3 位为 0），应用偏移
- 偏移量固定约 ±22（BTC），换取更高的触发概率
- 止损**不偏移**（止损触发是保护机制，无需刻意避开整数位）

**执行命令：**

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
  --tpTriggerPx <tp1> \
  --tpOrdPx=-1 \
  --slTriggerPx <sl> \
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
  --tpTriggerPx <tp2> \
  --tpOrdPx=-1 \
  --slTriggerPx <sl> \
  --slOrdPx=-1
```

**注意方向：**
- 做多平仓：`--side sell`
- 做空平仓：`--side buy`

##### 7.1.7 核对结果

**核对持仓：**

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP
```

核对项目：
- 持仓方向是否正确
- 持仓张数是否接近预期（允许 ±1 张误差）
- 持仓均价是否在入场区间内

**核对止盈止损：**

```bash
okx-proxy.sh --profile live swap algo orders --instId BTC-USDT-SWAP
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
[$NOW] [阶段三] 开仓成功 | 方向: long/short | 张数: xx | 成交价: xx | 止盈: [xx, xx] | 止损: xx | 订单ID: xx | 止盈止损ID: [xx, xx]
```

---

#### 7.2 加仓流程

**加仓前提：当前已有持仓**

**执行步骤：**

##### 7.2.1 获取当前持仓信息

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP
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

使用与开仓相同的计算逻辑：
- `sz_add = equity × position_size / (价格 × ctVal)`

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

##### 7.2.5 更新止盈止损

⚠️ **加仓后必须重新设置止盈止损，覆盖全部仓位！**

**新总仓位 = 原仓位 + 加仓张数**

取消旧止盈止损订单：
```bash
okx-proxy.sh --profile live swap algo cancel --instId BTC-USDT-SWAP --algoId <旧algoId>
```

设置新的止盈止损（覆盖全部新仓位）：
- 两档止盈各覆盖新总仓位的 50%
- 止损覆盖新总仓位全部

##### 7.2.6 核对结果

与开仓流程相同。

---

#### 7.3 减仓流程

**减仓前提：当前已有持仓**

**执行步骤：**

##### 7.3.1 获取当前持仓信息

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP
```

##### 7.3.2 计算减仓张数

根据日报建议的减仓比例：
- `sz_reduce = 当前持仓张数 × 减仓比例`
- 或直接按建议张数减仓

##### 7.3.3 执行部分平仓

```bash
okx-proxy.sh --profile live swap close \
  --instId BTC-USDT-SWAP \
  --sz <sz_reduce> \
  --tdMode isolated \
  --posSide <long|short>
```

##### 7.3.4 更新止盈止损

⚠️ **减仓后必须重新设置止盈止损，覆盖剩余仓位！**

**剩余仓位 = 原仓位 - 减仓张数**

取消旧止盈止损订单，设置新订单覆盖剩余仓位。

##### 7.3.5 核对结果

确认剩余持仓张数正确，止盈止损覆盖全部剩余仓位。

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

```bash
okx-proxy.sh --profile live swap close \
  --instId BTC-USDT-SWAP \
  --tdMode isolated \
  --posSide <long|short>
```

不指定 `--sz` 表示平掉全部仓位。

##### 7.4.3 等待成交确认

```bash
okx-proxy.sh --profile live account positions --instId BTC-USDT-SWAP
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
okx-proxy.sh --profile live swap algo orders --instId BTC-USDT-SWAP
```

记录所有 algoId。

##### 7.5.2 取消旧订单

```bash
okx-proxy.sh --profile live swap algo cancel-all --instId BTC-USDT-SWAP
```

或逐个取消。

##### 7.5.3 设置新止盈止损

根据日报建议的新价位，设置两档止盈 + 止损（与开仓流程相同）。

##### 7.5.4 核对结果

确认新订单状态为 `live`，触发价正确。

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

**归档操作：**

```bash
# 移动周期文件夹
mv active/cycle-YYYYMMDD-XXX archived/

# 记录归档信息
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段三] 周期归档 | cycle-xxx → archived/ | 平仓盈亏: xx USDT | 平仓类型: xx" >> logs/daily-report-process.log
```

##### 9.3 不满足归档条件

周期继续，记录状态：

```
[$NOW] [阶段三] 周期继续 | 当前持仓: X 个 | 状态: active
```

---

### 步骤 10: Spawn 阶段四

**构建 Spawn 消息：**

```
阶段三仓位管理已完成。
周期状态: [所有仓位平仓，已完成归档/周期活跃中]
周期路径: [已归档 | active/cycle-xxx]
请读取 tasks/daily-report-stage4.md 开始阶段四警报管理。
```

**说明：**
- 周期状态：决定阶段四执行清零还是正常管理
- 周期路径：定位日报文件（仅 active 状态需要）
- 持仓状态、最近平仓：不影响阶段四流程，不传递

**Spawn：**

```
sessions_spawn:
- agentId: "july"
- mode: "run"
- timeoutSeconds: 0
- task: [上述消息]
```

**执行后立即返回**，不等待阶段四完成。

---

### 步骤 11: 记录阶段结束

**Spawn 完成后，记录本阶段结束：**

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [阶段三] 完成执行，已 spawn 阶段四" >> logs/daily-report-process.log
echo "[$NOW] [阶段三] ========== 阶段三结束 ========== " >> logs/daily-report-process.log
```

---

## 异常处理

### 下单失败

1. 记录日志：`[$NOW] [阶段三] ⛔ ERROR: 下单失败 - [错误信息]`
2. 不继续后续步骤（止盈止损设置等）
3. 同步持仓文件（确认状态）
4. 继续流程（Spawn 阀段四）

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

1. **⭐ 优先解析 spawn 消息获取日报路径**：从阶段二传递的消息中获取日报路径
2. **保底措施必须执行**：spawn 解析失败时，从本地默认路径查找日报
3. **阅读整篇日报**：理解分析逻辑，提炼仓位意图（阶段三本职工作）
4. **必须读持仓文件**：验证建议合理性
5. **操作必须明确**：立即入场才执行，等待触发跳过
6. **安全限制不变**：杠杆 3x、逐仓、止盈止损必须覆盖全部
7. **执行后必须同步持仓**：调用 sync-positions 逻辑更新文件
8. **归档判断基于「最近平仓」**：观察持仓文件字段
9. **⭐ Spawn 消息传递周期状态**：供阶段四决定清零还是正常管理
10. **必须 spawn 阶段四**：完成后触发警报管理
11. **异常分级记录**：`⚠️ WARN` 不中断，`⛔ ERROR` 视情况处理
12. **日志完整记录**：每个关键步骤都有日志

---

阶段三-v4.19（完整版）