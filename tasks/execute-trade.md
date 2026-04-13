# 仓位执行任务规则

当日报任务或即时分析任务完成交易建议管理后，**无论是否有待开仓建议，都必须调用此任务**。

---

## 触发时机

此任务在以下场景被调用：

| 调用方 | 调用位置 | 调用条件 |
|--------|---------|---------|
| 日报任务 | 步骤6（仓位执行检查） | **无条件路由**，必须执行 |
| 即时分析任务 | 步骤7（仓位执行检查） | **无条件路由**，必须执行 |

---

## 执行前检查（必须记录日志）

### 1. 读取当前周期状态

```bash
# 检查活跃周期
ls -d active/cycle-* 2>/dev/null
```

如果 `active/` 为空，**终止执行**，记录日志：
```
[YYYY-MM-DD HH:mm:ss] 无活跃周期，跳过仓位执行
```

### 2. 读取交易建议文件

读取 `active/cycle-*/trade-suggestions.json`

### 3. 分析建议状态并记录日志（必须执行）

遍历所有建议，根据状态记录不同的日志：

| 状态 | entry_actual | 日志内容 |
|------|-------------|---------|
| `open` | `null` | 待开仓，继续执行开仓流程 |
| `open` | 有值 | `[建议: sug-xxx] 已开仓 | 入场价: xxx | 入场时间: xxx` |
| `pending_entry` | - | `[建议: sug-xxx] 等待入场 | 条件: xxx` |
| `closed` | - | `[建议: sug-xxx] 已平仓 | 平仓原因: xxx` |

**如果无建议（`suggestions` 数组为空）：**
```
[YYYY-MM-DD HH:mm:ss] 无交易建议，观望状态
```

**筛选真正待执行的建议：**
- `status === "open"` 且 `entry_actual === null`

如果无待执行建议，记录完上述日志后**终止执行**（不需要继续开仓流程）。

---

## 安全限制（必须严格遵守）

⚠️ **以下限制在任何情况下都不可违反：**

| 限制项 | 值 | 说明 |
|--------|---|------|
| 默认杠杆 | 3x | **绝对不允许更改杠杆** |
| 仓位模式 | isolated（逐仓） | 必须使用逐仓模式 |
| 止损要求 | 必须 | 止损必须覆盖全部仓位 |
| 止盈要求 | 必须 | 分批止盈必须覆盖全部仓位（两档止盈合计100%） |

---

## 仓位计算规则

### 计算公式

交易建议中的 `position_size` 格式为 `"xx%"`（如 `"100%"`, `"50%"`），表示相对于账户总权益的仓位比例。

**计算步骤：**

1. 获取账户USDT权益（`equity`）
2. 计算实际价值：`actual_value = equity × position_size_percent`
3. 计算保证金：`margin = actual_value / leverage`（杠杆固定为3）
4. 根据合约面值计算下单张数

**示例：**

```
position_size = "100%"
equity = 500 USDT
leverage = 3

actual_value = 500 × 100% = 500 USDT（实际仓位价值）
margin = 500 / 3 = 166.67 USDT（所需保证金）
```

### 获取合约信息

下单前必须获取合约信息：

```bash
okx-proxy.sh market instruments --instType SWAP | grep <instId>
```

关键参数：
- `ctVal`：合约面值（每张合约对应的基础资产数量）
- `minSz`：最小下单张数
- `lotSz`：下单步长

### 计算下单张数

对于 BTC-USDT-SWAP（ctVal = 0.01 BTC）：

```
张数 = actual_value / (当前价格 × ctVal)
张数 = 向下取整到 lotSz 精度
张数 = max(张数, minSz)
```

对于 ETH-USDT-SWAP（ctVal = 0.1 ETH）：

```
张数 = actual_value / (当前价格 × ctVal)
张数 = 向下取整到 lotSz 精度
张数 = max(张数, minSz)
```

---

## 执行步骤

### 1. 获取账户余额

```bash
okx-proxy.sh --profile live account balance USDT
```

记录 `equity`（权益）和 `available`（可用余额）。

**安全检查：**
- 如果 `available < margin`，**终止下单**，记录日志：`可用余额不足，需要 xx USDT，可用 xx USDT`

### 2. 获取当前价格和合约信息

```bash
# 获取当前价格
okx-proxy.sh market ticker <instId>

# 获取合约信息
okx-proxy.sh market instruments --instType SWAP | grep <instId>
```

### 3. 计算下单参数

根据交易建议计算：

| 参数 | 来源 | 计算方式 |
|------|------|---------|
| instId | 建议 | 如 BTC-USDT-SWAP |
| side | 建议 | direction: long → buy, short → sell |
| sz | 计算 | actual_value / (价格 × ctVal)，取整 |
| tdMode | 固定 | isolated（逐仓） |
| lever | 固定 | 3（不更改） |

### 4. 执行下单

```bash
okx-proxy.sh --profile live swap place \
  --instId <instId> \
  --side <buy|sell> \
  --ordType market \
  --sz <张数> \
  --tdMode isolated \
  --posSide <long|short>
```

**注意：** 不传递 `--lever` 参数，保持账户默认杠杆设置（应为3x）。

**下单结果处理：**
- 成功：记录订单ID `ordId`
- 失败：记录错误，终止执行

### 5. 等待成交确认

下单后等待2秒，然后查询持仓确认成交：

```bash
okx-proxy.sh --profile live account positions --instId <instId>
```

记录：
- `avgPx`：平均成交价（作为实际入场价）
- `pos`：持仓张数

### 6. 设置止盈止损

⚠️ **必须创建止盈止损！**

根据交易建议的 `take_profit` 和 `stop_loss` 设置OCO订单。

**止盈止损分配规则：**

假设建议有 `take_profit: [tp1, tp2]` 和 `stop_loss: sl`，仓位为 `sz` 张：

| 订单 | 类型 | 张数 | 触发价 | 说明 |
|------|------|------|--------|------|
| TP1 | OCO | sz/2 | tp1 | 第一档止盈，平仓50% |
| TP2 | OCO | sz/2 | tp2 | 第二档止盈，平仓剩余50% |
| SL | OCO | sz | sl | 止损，平仓全部 |

**⭐ 整数位偏移规则（止盈专用）：**

整数价位（如 72000、75000）常有强大阻力，价格可能差一点不到。设置止盈时需酌情偏移：

| 方向 | 原止盈价 | 实际设置 | 示例 |
|------|---------|---------|------|
| 多单 | 72500 | 72500 - 22 = **72478** | 略低，更容易触发 |
| 空单 | 72500 | 72500 + 22 = **72522** | 略高，更容易触发 |

**判断逻辑：**
- 如果止盈价是整数（末尾2-3位为0），应用偏移
- 偏移量固定约 ±22（BTC），换取更高的触发概率
- 止损**不偏移**（止损触发是保护机制，无需刻意避开整数位）

**执行命令：**

```bash
# 第一档止盈（sz/2张）
okx-proxy.sh --profile live swap algo place \
  --instId <instId> \
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

# 第二档止盈（sz/2张）
okx-proxy.sh --profile live swap algo place \
  --instId <instId> \
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

**止盈止损设置结果处理：**
- 成功：记录 algoId
- 失败：记录错误，尝试重新设置

---

## 执行后核对（必须执行）

### 1. 核对持仓

```bash
okx-proxy.sh --profile live account positions --instId <instId>
```

核对项目：
- 持仓方向是否正确
- 持仓张数是否接近预期（允许 ±1 张误差）
- 持仓均价是否在入场区间内

### 2. 核对止盈止损

```bash
okx-proxy.sh --profile live swap algo orders --instId <instId>
```

核对项目：
- 止盈订单数量应为 2（两档止盈）
- 止盈触发价是否正确
- 止损触发价是否正确
- 所有订单状态应为 `live`

### 3. 核对账户余额

```bash
okx-proxy.sh --profile live account balance USDT
```

核对项目：
- 余额扣除是否合理（保证金 + 手续费）
- 冻结金额是否正确

---

## 更新交易建议文件

核对完成后，更新 `trade-suggestions.json`：

```json
{
  "status": "open",
  "entry_actual": <成交均价>,
  "entry_at": <下单时间>,
  "entry_confirmed_by": "execute-trade",
  "ordId": <订单ID>,
  "algoIds": [<止盈止损订单ID列表>],
  "pos_actual": <实际持仓张数>,
  "margin_actual": <实际保证金>
}
```

---

## 日志记录（必须执行）

日志文件：`logs/trade-execution.log`

**成功日志格式：**

```
[YYYY-MM-DD HH:mm:ss] 仓位创建成功 | 周期: cycle-xxx | 建议: sug-xxx | 币对: xxx | 方向: long/short | 张数: xxx | 成交价: xxx | 杠杆: 3x | 止盈: [xxx, xxx] | 止损: xxx | 订单ID: xxx | 止盈止损ID: [xxx, xxx] | 保证金: xxx USDT
```

**失败日志格式：**

```
[YYYY-MM-DD HH:mm:ss] 仓位创建失败 | 周期: cycle-xxx | 建议: sug-xxx | 错误: 具体错误信息
```

**核对日志格式：**

```
[YYYY-MM-DD HH:mm:ss] 核对完成 | 建议: sug-xxx | 持仓: xxx张 @ xxx | 止盈订单: 2个 | 止损订单: 覆盖全部 | 状态: 正常/异常
```

**异常情况日志：**

```
[YYYY-MM-DD HH:mm:ss] 核对异常 | 建议: sug-xxx | 问题: 具体问题描述 | 建议: 手动检查/重新设置止盈止损
```

---

## 异常处理

### 下单失败

1. 记录日志
2. 不更新交易建议文件
3. 向飞书发送警报消息

### 止盈止损设置失败

1. 记录日志
2. 尝试重新设置（最多3次）
3. 如仍失败，向飞书发送警报消息，提示手动设置

### 核对异常

1. 记录日志
2. 向飞书发送警报消息
3. 不更新交易建议文件

---

## 完整执行流程总结

```
1. 检查周期状态 → 无周期则终止
2. 读取交易建议 → 无待执行则终止
3. 获取账户余额 → 余额不足则终止
4. 获取价格和合约信息
5. 计算下单参数
6. 执行下单
7. 等待成交确认
8. 设置止盈止损（两档止盈 + 止损）
9. 核对持仓
10. 核对止盈止损
11. 核对账户余额
12. 更新交易建议文件
13. 记录日志
```

---

## 调用示例

在日报任务或即时分析任务中，完成交易建议写入后：

```
# 检查是否有待执行建议
# 如有，调用此任务
阅读 tasks/execute-trade.md，按步骤执行
```

**注意：** 此任务不是独立触发的，而是由日报任务或即时分析任务在完成后调用。