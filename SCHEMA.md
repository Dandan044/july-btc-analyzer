# SCHEMA.md - 数据结构说明

本文档描述七月生成的市场数据 JSON 文件的结构。

---

## 顶层结构

```json
{
  "timestamp": "2026-04-15 12:00:37",
  "priceHistory": { ... },
  "kline4h": [ ... ],
  "options": [ ... ],
  "fibonacci": { ... },
  "dataSource": { ... }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `timestamp` | string | 数据获取时间（北京时间） |
| `priceHistory` | object | 日线价格历史及统计 |
| `kline4h` | array | 4小时K线数据 |
| `options` | array | 期权市场数据（Deribit） |
| `fibonacci` | object | 多时间框架斐波那契回调分析 |
| `dataSource` | object | 数据来源标识 |

---

## priceHistory（日线数据）

```json
{
  "current": 74297.3,
  "days": 14,
  "volume24h": 712916629093.13,
  "history": [ ... ],
  "statistics": { ... },
  "indicators": { ... }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `current` | number | 当前价格（最新日线收盘价） |
| `days` | number | 历史数据天数 |
| `volume24h` | number | 24小时交易量（美元） |
| `history` | array | 每日日线数据（14天） |
| `statistics` | object | 14日/30日统计汇总 |
| `indicators` | object | 技术指标（RSI等） |

### history（每日记录）

```json
{
  "date": "2026-04-15",
  "timestamp": 1776182400000,
  "open": 75280.4,
  "high": 75668.3,
  "low": 73743.9,
  "close": 74297.3,
  "volume": null,
  "quoteVolume": null,
  "ema7": 70946.35,
  "ema12": 70293.29,
  "ema20": 70212.48,
  "ema26": 70030.2,
  "fearGreed": 23,
  "fundingRate": -0.0000425181840774,
  "openInterest": 3481140857.787,
  "openInterestValue": 258639366653258.1,
  "longShortRatio": 0.83,
  "topTraderRatio": 0.6488095238095238,
  "takerRatio": 1.1505077413325298,
  "takerBuyVol": 95291604.2599,
  "takerSellVol": 82825695.8528
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `date` | string | 日期（北京时间） |
| `timestamp` | number | 时间戳（毫秒） |
| `open` | number | 开盘价 |
| `high` | number | 最高价 |
| `low` | number | 最低价 |
| `close` | number | 收盘价 |
| `volume` | number/null | 交易量（BTC，当天为null） |
| `quoteVolume` | number/null | 交易量（美元，当天为null） |
| `ema7/12/20/26` | number | EMA均线值 |
| `fearGreed` | number | 恐慌贪婪指数（0-100） |
| `fundingRate` | number | 资金费率 |
| `openInterest` | number | 持仓量（BTC） |
| `openInterestValue` | number | 持仓量（美元） |
| `longShortRatio` | number | 多空比（>1多头占优） |
| `topTraderRatio` | number | 大户多空比 |
| `takerRatio` | number | Taker买卖比（>1买方占优） |
| `takerBuyVol` | number | Taker买入量 |
| `takerSellVol` | number | Taker卖出量 |

### statistics（统计汇总）

```json
{
  "days14": {
    "price": { "max", "min", "avg", "rangePosition" },
    "volume": { "max", "min", "avg", "volumeRatio" }
  },
  "days30": {
    "price": { ... },
    "volume": { ... }
  }
}
```

- `rangePosition`: 当前价格在区间中的位置百分比（0%=最低，100%=最高）
- `volumeRatio`: 24小时交易量与平均交易量的比值

### indicators（技术指标）

```json
{
  "rsi14": 62.2
}
```

---

## kline4h（4小时K线）

```json
{
  "time": "2026-04-15 12:00",
  "timestamp": 1776225600000,
  "open": 74296.3,
  "high": 74314.3,
  "low": 74296.2,
  "close": 74297.3,
  "volume": 1920.9,
  "quoteVolume": 1427261.88101,
  "longShortRatio": 0.8,
  "topTraderRatio": 0.644945403311025,
  "takerRatio": 0.9708649938194209,
  "takerBuyVol": 74890898.4002,
  "takerSellVol": 77138323.9451
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `time` | string | 时间（北京时间） |
| `timestamp` | number | 时间戳（毫秒） |
| `open/high/low/close` | number | K线四价 |
| `volume` | number | 交易量（BTC） |
| `quoteVolume` | number | 交易量（美元） |
| `longShortRatio` | number | 多空比 |
| `topTraderRatio` | number | 大户多空比 |
| `takerRatio` | number | Taker买卖比 |
| `takerBuyVol` | number | Taker买入量 |
| `takerSellVol` | number | Taker卖出量 |

---

## options（期权数据）

来自 Deribit 期权市场，返回持仓量最大的两个到期日。

```json
{
  "expiry": "24APR26",
  "expiryDate": "24APR26",
  "contractCount": 96,
  "totalOpenInterest": 99070,
  "callOpenInterest": 53670,
  "putOpenInterest": 45400,
  "putCallRatioOI": 0.846,
  "totalVolume": 7554,
  "callVolume": 3466,
  "putVolume": 4088,
  "putCallRatioVolume": 1.179,
  "averageImpliedVolatility": 59.9,
  "maxPainPrice": 67500,
  "topResistance": [ ... ],
  "topSupport": [ ... ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `expiry` | string | 到期日标识 |
| `contractCount` | number | 合约数量 |
| `totalOpenInterest` | number | 总持仓量（BTC） |
| `callOpenInterest` | number | 看涨期权持仓量 |
| `putOpenInterest` | number | 看跌期权持仓量 |
| `putCallRatioOI` | number | Put/Call持仓比（>1看跌情绪占优） |
| `totalVolume` | number | 当日总交易量 |
| `callVolume` | number | 看涨期权交易量 |
| `putVolume` | number | 看跌期权交易量 |
| `putCallRatioVolume` | number | Put/Call交易量比 |
| `averageImpliedVolatility` | number | 平均隐含波动率（%） |
| `maxPainPrice` | number | 最大痛点价格 |
| `topResistance` | array | 主要阻力位（净看涨持仓大的执行价） |
| `topSupport` | array | 主要支撑位（净看跌持仓大的执行价） |

---

## fibonacci（斐波那契回调）

多时间框架斐波那契分析（日线、4小时、周线）。

```json
{
  "currentPrice": 93648.1,
  "daily": {
    "timeframe": "日线",
    "swingHigh": 97925.4,
    "swingLow": 60000,
    "swingRange": 37925.4,
    "fibonacciLevels": {
      "level_0_percent": { "price": 97925.4, "label": "波段高点" },
      "level_23_6_percent": { "price": 88975.01, "label": "23.6%回调" },
      "level_38_2_percent": { "price": 83437.9, "label": "38.2%回调" },
      "level_50_percent": { "price": 78962.7, "label": "50%回调" },
      "level_61_8_percent": { "price": 74487.5, "label": "61.8%回调" },
      "level_78_6_percent": { "price": 68116.04, "label": "78.6%回调" },
      "level_100_percent": { "price": 60000, "label": "波段低点" }
    }
  },
  "fourHour": { ... },
  "weekly": { ... }
}
```

- 斐波那契回调位从波段高点计算（0%=高点，100%=低点）
- 61.8%是黄金分割位，最关键的支撑/阻力参考

---

## dataSource（数据来源）

```json
{
  "price": "OKX CLI",
  "sentiment": "OKX CLI + alternative.me"
}
```

---

## 更新历史

| 日期 | 变更 |
|------|------|
| 2026-04-15 | 将 `fearGreedIndex` 整合到 `history` 每日记录的 `fearGreed` 字段，删除顶层独立字段 |
| 2026-04-15 | 初版创建 |

---

*七月 - 比特币交易分析师*