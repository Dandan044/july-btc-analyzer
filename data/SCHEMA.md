# 数据字段说明

> 最后更新: 2026-04-15

---

## 一、顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `timestamp` | string | 数据获取时间（北京时间）|
| `priceHistory` | object | 日线级别价格和交易数据 |
| `kline4h` | array | 4小时级别K线数据（14根）|
| `options` | array | 期权市场数据（Deribit）|
| `fibonacci` | object | 多时间框架斐波那契回调分析 |
| `dataSource` | object | 数据来源信息 |


---

## 二、priceHistory（日线数据）

| 字段 | 类型 | 说明 |
|------|------|------|
| `current` | number | 当前价格（USD）|
| `days` | number | 历史数据天数（14）|
| `volume24h` | number | **24小时聚合交易量**（USDT），当日完整交易量 |
| `history` | array | 14天历史数据（每天一条）|
| `statistics` | object | 统计数据（14日/30日）|
| `indicators` | object | 技术指标 |

---

## 三、priceHistory.history[每条]（日线详情）

### 基础价格数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `date` | string | 日期（YYYY-MM-DD）|
| `timestamp` | number | 时间戳（毫秒）|
| `open` | number | 开盘价 |
| `high` | number | 最高价 |
| `low` | number | 最低价 |
| `close` | number | 收盘价 |
| `volume` | number/null | 交易量（BTC），**当日为null** |
| `quoteVolume` | number/null | 交易量（USDT），**当日为null** |

### EMA 均线

| 字段 | 类型 | 说明 |
|------|------|------|
| `ema7` | number | 7日指数移动平均线 |
| `ema12` | number | 12日指数移动平均线 |
| `ema20` | number | 20日指数移动平均线 |
| `ema26` | number | 26日指数移动平均线 |

> **EMA 用途**：判断趋势方向。价格在EMA上方=上升趋势，下方=下降趋势

### 情绪指标

| 字段 | 类型 | 说明 |
|------|------|------|
| `fearGreed` | number | **恐慌贪婪指数**（0-100），<25极度恐惧，>75极度贪婪 |

> **用途**：市场情绪判断。极度恐惧可能是抄底机会，极度贪婪可能预示回调。

### 交易侧数据

| 字段 | 类型 | 说明 |
|------|------|------|
| `fundingRate` | number | **资金费率**，正=多头付费给空头，负=空头付费给多头 |
| `openInterest` | number | **持仓量**（BTC），未平仓合约总数 |
| `openInterestValue` | number | 持仓量价值（USDT）|
| `longShortRatio` | number | **多空人数比**，>1=多头多，<1=空头多 |
| `longAccount` | number | 多头账户占比（0-1）|
| `shortAccount` | number | 空头账户占比（0-1）|
| `topTraderRatio` | number | **大户持仓多空比**，大户的持仓比例 |
| `topTraderLong` | number | 大户多头持仓占比 |
| `topTraderShort` | number | 大户空头持仓占比 |
| `takerRatio` | number | **Taker买卖比**，主动买入/主动卖出 |
| `takerBuyVol` | number | 主动买入量（BTC）|
| `takerSellVol` | number | 主动卖出量（BTC）|

---

## 四、priceHistory.statistics（统计）

### days14（14日统计）

| 字段 | 说明 |
|------|------|
| `price.max` | 14日最高价 |
| `price.min` | 14日最低价 |
| `price.avg` | 14日均价 |
| `price.rangePosition` | 当前价格在14日区间的位置（%）|
| `volume.max` | 14日最大交易量 |
| `volume.min` | 14日最小交易量 |
| `volume.avg` | 14日平均交易量 |
| `volume.volumeRatio` | 24h交易量 / 14日均值 |

### days30（30日统计）

| 字段 | 说明 |
|------|------|
| `price.max` | 30日最高价 |
| `price.min` | 30日最低价 |
| `price.avg` | 30日均价 |
| `price.rangePosition` | 当前价格在30日区间的位置（%）|
| `volume.max` | 30日最大交易量 |
| `volume.min` | 30日最小交易量 |
| `volume.avg` | 30日平均交易量 |
| `volume.volumeRatio` | 24h交易量 / 30日均值 |

---

## 五、priceHistory.indicators（技术指标）

| 字段 | 类型 | 说明 |
|------|------|------|
| `rsi14` | number | **RSI(14)**：相对强弱指标，0-100，<30超卖，>70超买 |
| `momentum7d` | number | **7日动量**：(当前价 - 7天前价) / 7天前价 × 100% |

---

## 六、kline4h[每条]（4小时K线）

与日线结构相同，区别：
- `time`：时间（YYYY-MM-DD HH:mm）
- 时间粒度为4小时
- 共14根K线

---

## 七、options（期权数据）

来自 Deribit 期权市场，返回持仓量最大的两个到期日。

| 字段 | 类型 | 说明 |
|------|------|------|
| `expiry` | string | 到期日标识（如 24APR26）|
| `contractCount` | number | 合约数量 |
| `totalOpenInterest` | number | 总持仓量（BTC）|
| `callOpenInterest` | number | 看涨期权持仓量（BTC）|
| `putOpenInterest` | number | 看跌期权持仓量（BTC）|
| `putCallRatioOI` | number | Put/Call持仓比，>1=看跌情绪占优 |
| `totalVolume` | number | 当日总交易量（BTC）|
| `callVolume` | number | 看涨期权交易量（BTC）|
| `putVolume` | number | 看跌期权交易量（BTC）|
| `putCallRatioVolume` | number | Put/Call交易量比 |
| `averageImpliedVolatility` | number | 平均隐含波动率（%）|
| `maxPainPrice` | number | 最大痛点价格，价格磁吸位 |
| `topResistance` | array | 主要阻力位（净看涨持仓大的执行价）|
| `topSupport` | array | 主要支撑位（净看跌持仓大的执行价）|

---

## 八、fibonacci（斐波那契回调）

多时间框架斐波那契分析（日线、4小时、周线）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `currentPrice` | number | 当前价格 |
| `daily` | object | 日线级别斐波那契分析 |
| `fourHour` | object | 4小时级别斐波那契分析 |
| `weekly` | object | 周线级别斐波那契分析 |

每个时间框架包含：
- `swingHigh`：波段高点
- `swingLow`：波段低点
- `swingRange`：波段幅度
- `fibonacciLevels`：各级回调位（0%、23.6%、38.2%、50%、61.8%、78.6%、100%）

> **用途**：61.8%（黄金分割）是最关键的支撑/阻力参考位。

---

## 九、指标解读速查

| 指标 | 看多信号 | 看空信号 |
|------|---------|---------|
| **资金费率** | < -0.05%（空头过热）| > 0.05%（多头过热）|
| **多空人数比** | < 0.8（过度看空）| > 2.5（过度看多）|
| **大户持仓比** | > 1（大户做多）| < 1（大户做空）|
| **Taker买卖比** | > 1.5（买方强势）| < 0.7（卖方强势）|
| **RSI** | < 30（超卖）| > 70（超买）|
| **恐惧贪婪** | < 25（极度恐惧）| > 75（极度贪婪）|

---

## 十、数据源

| 数据 | 来源 | 备注 |
|------|------|------|
| 价格/OHLCV/交易量 | OKX CLI/API | 需要代理，服务端计算技术指标 |
| 资金费率 | OKX API | 需要代理 |
| 持仓量(OI) | OKX API | 需要代理 |
| 多空比/Taker比 | OKX API | 需要代理 |
| 恐惧贪婪指数 | alternative.me | 无需代理，整合到每日记录 |
| 期权数据 | Deribit API | 需要代理 |