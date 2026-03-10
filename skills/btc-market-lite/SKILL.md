---
name: BTC Market Lite
description: 轻量级比特币市场数据获取（国内可用）。使用 CryptoCompare 和 alternative.me 免费公开 API，无需认证，获取价格、OHLCV、恐惧贪婪指数及技术指标。适合定时报告和技术分析。
metadata:
  openclaw:
    requires: { bins: ["node"] }
---

# BTC Market Lite 技能

轻量级比特币市场数据获取工具，专为国内网络环境优化，支持技术指标计算。

## 特点

- **国内可用**：使用 CryptoCompare 和 alternative.me，国内可直接访问
- **无需认证**：完全免费，无需 API Key
- **OHLCV 数据**：开盘价、最高价、最低价、收盘价、成交量
- **技术指标**：内置 SMA、EMA、RSI、动量、波动率计算

## 数据源

| 数据 | API | 更新频率 |
|------|-----|----------|
| 比特币价格/历史 | CryptoCompare | 实时 |
| OHLCV | CryptoCompare | 分钟/小时/日级别 |
| 恐惧贪婪指数 | alternative.me/fng | 每日 |

## 工具脚本

### 1. 增强技术分析（推荐）

```bash
node scripts/get_enhanced_analysis.js [--json] [--save]
```

**参数说明：**
- `--json`：输出 JSON 格式
- `--save`：自动保存到 `data/YYYY-MM-DD.json`（推荐）

**推荐用法（智能体集成）：**
```bash
# 获取数据并自动保存，无需智能体手动写入
node scripts/get_enhanced_analysis.js --save
```

**输出包含：**
- 💰 价格数据（当前价格、1h/24h/7d变化）
- 📈 价格历史（OHLCV：开高低收量）
- 😰 恐惧贪婪指数分析
  - 当前值及分类
  - SMA7/14/30、EMA7 移动平均
  - RSI(14)、波动率、动量指标
  - 30日统计（均值、最高、最低、区间位置）
  - 历史对比

### 2. API 模块

```bash
# 供其他脚本/规则复用的 API 模块
const api = require('./scripts/api.js');
api.getTicker();      // 实时价格
api.get24hVolume();   // 24小时聚合交易量
api.getPriceHistory(); // 历史价格
api.getKlines();      // K线数据
```

### 3. 恐惧贪婪指数

```bash
node scripts/get_fear_greed.js --days=30 # 恐惧贪婪指数历史
```

## 智能体集成

**推荐使用增强分析脚本：**

```bash
# 获取完整技术分析数据
node scripts/get_enhanced_analysis.js --json
```

智能体应该：
1. 调用 `get_enhanced_analysis.js --json` 获取原始数据
2. 基于 marketAssessment 中的信号进行判断
3. 结合恐惧贪婪指数的技术指标给出分析
4. 生成自己的报告

## 技术指标说明

### 恐惧贪婪指数衍生指标

| 指标 | 计算方式 | 用途 |
|------|----------|------|
| **SMA** | 简单移动平均 | 判断趋势方向 |
| **EMA** | 指数移动平均 | 更灵敏的趋势判断 |
| **RSI** | 相对强弱指标 | 超买/超卖判断 |
| **波动率** | 30日标准差 | 市场稳定性 |
| **动量** | N日变化率 | 情绪变化速度 |

### 信号权重

| 条件 | 信号 | 强度 |
|------|------|------|
| 恐惧贪婪 ≤ 25 | 看多 | ⭐⭐⭐ |
| 恐惧贪婪 25-45 | 看多 | ⭐⭐ |
| 恐惧贪婪 55-75 | 看空 | ⭐ |
| 恐惧贪婪 ≥ 75 | 看空 | ⭐⭐⭐ |
| EMA > SMA | 看多 | ⭐ |
| RSI < 30 | 看多 | ⭐⭐ |
| RSI > 70 | 看空 | ⭐⭐ |
| 动量 > 20% | 看空（过热） | ⭐ |
| 动量 < -20% | 看多（超卖） | ⭐ |

## 注意事项

- CryptoCompare API 有速率限制，免费版约 100,000 次/月
- 恐惧贪婪指数每日更新一次
- 价格技术指标基于日级别 OHLCV 数据计算
- 本技能仅提供 BTC 数据
- **交易量数据必须使用 24h 聚合方式**，不接受当日不完整数据

## 更新日志

- 2026-03-03: **v2 重构** - 主数据源切换为 CryptoCompare API，支持 OHLCV 数据，旧版作为备用保留
- 2026-02-27: 新增增强技术分析脚本，支持 SMA/EMA/RSI/动量/波动率计算
- 2026-02-27: 初始版本