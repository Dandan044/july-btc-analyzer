---
name: BTC Market Lite
description: 轻量级比特币市场数据获取（国内可用）。使用 CryptoCompare 和 alternative.me 免费公开 API，无需认证，获取价格、OHLCV、恐惧贪婪指数及技术指标。适合定时报告和技术分析。
metadata:
  openclaw:
    requires: { bins: ["node"] }
---

# BTC Market Lite 技能

比特币市场数据获取工具，整合多数据源，支持日线和4小时两种粒度。

## 数据源

| 数据 | API | 更新频率 | 说明 |
|------|-----|----------|------|
| 价格/OHLCV | CryptoCompare | 实时 | 无需代理，警报器专用 |
| 恐惧贪婪指数 | alternative.me | 每日 | 无需代理 |
| K线+技术指标 | OKX CLI | 实时 | 需代理，服务端计算 EMA/RSI |
| 资金费率 | OKX API | 8小时 | 需代理 |
| 持仓量(OI) | OKX API | 实时 | 需代理 |
| 多空情绪 | OKX API | 1日 | 需代理 |
| Taker买卖比 | OKX API | 1日 | 需代理 |

## 用法

### 基本用法

```bash
# 获取完整数据（默认使用代理）
node scripts/get_enhanced_analysis.js

# JSON 输出
node scripts/get_enhanced_analysis.js --json

# 保存到 data/YYYY-MM-DD.json
node scripts/get_enhanced_analysis.js --save

# 组合使用
node scripts/get_enhanced_analysis.js --json --save

# 指定代理地址
node scripts/get_enhanced_analysis.js --proxy http://127.0.0.1:7890
```

### 智能体集成

```bash
# 日报任务推荐用法
node scripts/get_enhanced_analysis.js --save
```

使用 `--save` 会自动保存到 `data/YYYY-MM-DD.json`。

## 数据结构

### 日线数据（30天）

| 数据 | 说明 | 分析价值 |
|------|------|---------|
| 价格历史 | 14天 OHLCV + EMA | ⭐⭐⭐ |
| 恐惧贪婪指数 | 当前值 + 30日统计 | ⭐⭐⭐ |
| 资金费率 | 30条历史（每8小时） | ⭐⭐⭐ 多空情绪周期 |
| 持仓量(OI) | 28天历史 | ⭐⭐⭐ 市场热度 |
| 多空人数比 | 28天日线 | ⭐⭐⭐ 散户情绪 |
| 大户持仓比 | 28天日线 | ⭐⭐⭐ 聪明钱方向 |
| Taker买卖比 | 28天日线 | ⭐⭐ 动能确认 |

### 4小时数据（14根）

| 数据 | 说明 |
|------|------|
| K线 | OKX 4h OHLCV |
| 资金费率 | 14条（约56小时） |
| 持仓量(OI) | 14条 |
| 多空人数比 | 14条 |
| 大户持仓比 | 14条 |
| Taker买卖比 | 14条 |

### 当前数据

| 数据 | 说明 |
|------|------|
| 当前资金费率 | 费率值、标记价格、下次结算时间 |
| 当前持仓量 | OI 数值 |

## 指标解读

### 资金费率

| 费率范围 | 信号 | 含义 |
|----------|------|------|
| > 0.05% | 🔥 多头过热 | 做多拥挤，警惕回调 |
| 0.01% ~ 0.05% | 看多 | 多头主导 |
| -0.05% ~ 0.01% | 中性 | 多空平衡 |
| -0.05% ~ -0.01% | 看空 | 空头主导 |
| < -0.05% | ❄️ 空头过热 | 做空拥挤，警惕反弹 |

### 多空人数比

| 比值 | 信号 | 含义 |
|------|------|------|
| > 2.5 | 过度看多 | 散户FOMO，警惕反转 |
| 1.5 ~ 2.5 | 看多 | 多头情绪主导 |
| 0.8 ~ 1.5 | 中性 | 多空分歧 |
| < 0.8 | 过度看空 | 散户恐慌，可能反转 |

### 大户持仓比

- 与散户情绪背离时关注反转信号
- 大户更可能是"聪明钱"

### Taker买卖比

| 比值 | 信号 |
|------|------|
| > 1.5 | 主动买入强势 |
| 0.7 ~ 1.5 | 相对平衡 |
| < 0.7 | 主动卖出强势 |

## 代理配置

国内访问 OKX API 需要代理。

**默认代理**: `http://127.0.0.1:7890`

**配置方法**:
```bash
# 方式1：命令行参数
node scripts/get_enhanced_analysis.js --proxy http://127.0.0.1:7890

# 方式2：使用 okx-proxy.sh wrapper（推荐）
./scripts/okx-proxy.sh market ticker BTC-USDT
```

## 注意事项

- CryptoCompare API 有速率限制（约 100,000 次/月），警报器专用
- 恐惧贪婪指数每日更新一次
- OKX 数据需要代理访问
- 无代理时仍可获取 CryptoCompare 价格数据和恐惧贪婪指数

## 更新日志

- 2026-04-10: **v5 重构** - 数据源从 Binance 改为 OKX CLI/API，服务端计算技术指标
- 2026-03-27: **v4 重构** - 整合交易数据（资金费率、OI、多空比、Taker比），支持日线和4小时两种粒度
- 2026-03-03: **v3 重构** - 简化输出，数据源切换为 CryptoCompare
- 2026-02-27: 新增增强技术分析脚本，支持 SMA/EMA/RSI/动量/波动率计算
- 2026-02-27: 初始版本