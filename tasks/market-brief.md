# 市场快报任务

每 8 小时生成一份加密市场环境快报，纯现象描述，不做主观分析和交易建议。

---

## 触发方式

- 由 cron 定时触发：每天 22:30、06:30、14:30（GMT+8）
- 触发时 spawn 独立隔离会话执行本任务
- cron 表达式：`30 22,6,14 * * *`（Asia/Shanghai）

---

## 核心原则

### ⛔ 铁律：纯现象描述

本报告**严禁**包含以下内容：

| 禁止 | 示例（错误） | 正确做法 |
|------|-------------|---------|
| 因果推断 | "价格上行由大资金驱动" | "价格上涨，OI同步增长" |
| 对未来预测 | "后续可能继续上涨" | （不写） |
| 交易建议 | "建议观望/缩仓" | "波动率上升，各板块涨跌分化明显" |
| 主观定性 | "这是健康的回调" | "价格从高点回落3.2%" |
| 数据解读 | "散户恐慌=买入机会" | "恐惧贪婪22，处于极度恐惧区间" |

**正确姿势：只描述已经发生的现象，让阅读者自己做判断。**

---

## 日志文件

路径：`logs/market-brief.log`

格式：追加模式。

```
[时间] [市场快报] 内容
[时间] [市场快报] ⚠️ WARN: 内容
[时间] [市场快报] ⛔ ERROR: 内容
```

---

## 输出文件

| 类型 | 路径 | 格式 |
|------|------|------|
| Markdown 报告 | `market-brief/reports/YYYY-MM-DD-HHMM.md` | 可读报告 |
| 结构化数据 | `market-brief/data/YYYY-MM-DD-HHMM.json` | JSON |

---

## 板块定义与币种映射

> 仅在 OKX SPOT 有 USDT 交易对的 123 个验证币种。`scripts/market-brief-process.py` 内置此映射。

| 板块 | 币种 |
|------|------|
| **L1 竞争链** | SOL, AVAX, NEAR, SUI, APT, INJ, SEI, TIA, DOT, ATOM, ADA, TRX, ICP, ALGO, XLM, HBAR, TON, HYPE, ETC, FLOW, MINA, ASTR, IOTA, ONT, ZIL, ICX, WAXP, CELR, ZETA |
| **L2 扩容** | ARB, OP, STRK, ZK, METIS, IMX, SCR, LRC, CELO, POL, SKL |
| **DeFi 蓝筹** | AAVE, UNI, CRV, COMP, SNX, LDO, ENA, EIGEN, PENDLE, SUSHI, 1INCH, DYDX, JUP, RAY, JTO, WLFI, LQTY, YFI, BNT |
| **AI / 数据** | FET, RENDER, WLD, ARKM, AIXBT, VIRTUAL, IP, AI, PHA, NMR |
| **Meme 币** | DOGE, PEPE, WIF, BONK, FLOKI, SHIB, GOAT, MOODENG, TOSHI, TRUMP, PUMP, PENGU, NEIRO, BOME, TURBO |
| **GameFi / 元宇宙** | SAND, MANA, GALA, RON, AXS, ACE, PIXEL, BIGTIME, APE, CHZ, AGLD, YGG, MAGIC, ILV |
| **RWA / 真实资产** | ONDO, CFG, PAXG, XAUT |
| **基础设施 / 预言机** | LINK, GRT, BAND, PYTH, API3, TRB |
| **交易所平台币** | BNB, OKB, CRO, LEO |
| **支付 / 支付网络** | XRP, LTC, BCH, ZEC, DASH, CORE, ZEN |
| **Depin / 存储** | FIL, AR, STORJ, GRASS |
| **其他** | 未归入以上板块但成交量 >$500K 的币种 |

---

## 执行步骤

### 1. 记录开始

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [市场快报] ========== 开始生成 ==========" >> logs/market-brief.log
```

### 2. 创建输出目录

```bash
mkdir -p market-brief/reports market-brief/data
```

---

### 3. 数据采集（一体化脚本）

**运行 `scripts/market-brief-collect.sh`，一次完成所有数据采集、加工和摘要输出：**

```bash
bash scripts/market-brief-collect.sh
```

**脚本内部流程：**
```
[1] OKX 全量行情 (299 USDT对, 1次请求)
[2] 恐惧贪婪指数 (alternative.me, 3天历史)
[3] BTC 衍生品 (费率/OI/多空比, 并行3请求)
[4] BTC 1H K线 (近6根, 推断走势)
[5] Python 加工 → /tmp/market-brief/processed.json
```

脚本 stdout 会打印：全市场摘要、板块表现、涨跌榜 Top10。

**⚠️ 完整性检查：** 若脚本执行失败，检查是否代理可达。确认 `/tmp/market-brief/processed.json` 存在后再继续。

#### 3.1 读取加工数据

读取 `/tmp/market-brief/processed.json` 获取完整结构化数据。

**关键字段速查：**

| JSON 路径 | 内容 |
|-----------|------|
| `.summary` | 币种总数、涨占比、均值、BTC 6h 振幅 |
| `.btc_kline_6h.description` | BTC 近 6 小时走势一句话描述 |
| `.btc_kline_6h.candles` | 6 根 1H K 线详情 |
| `.fear_greed` | 当前值、分类、趋势、前值 |
| `.btc_derivatives` | 费率(%及状态)、OI(张)、多空比(及状态) |
| `.majors.BTC/.ETH/.SOL/.BNB/.XRP/.DOGE` | 价格、24h 涨跌、6h 涨跌(BTC) |
| `.sectors[]` | 各板块：均值、涨跌币数、score、描述、领涨/领跌 |
| `.top_gainers[]` / `.top_losers[]` | 涨跌榜 Top10（已过滤 $500K 以下）|

#### 3.2 获取近期新闻

使用 `web_search` 搜索最近 24 小时加密市场新闻：

```
查询词: "crypto market news today"
freshness: day, count: 5
```

收集 3-5 条新闻，只记录标题、归类、是否观察到相关币种价格异动。

---

### 4. 生成报告

数据采集脚本已完成绝大部分计算工作。LLM 只需：

#### 4.1 确认市场评分

脚本会输出建议的 `market_score`。基于 stdout 摘要和 `processed.json` 确认分数合理（可 ±1~2 微调）。

**评分尺度：**

| 分值 | 描述 | 触发条件（脚本内置） |
|------|------|---------------------|
| 10 | 普遍强势上涨 | 涨占比 >80% 且均值 >3% |
| 8 | 强势上涨 | 涨占比 >75% 且均值 >2% |
| 7 | 明显上涨 | 涨占比 >70% 且均值 >1.5% |
| 6 | 普涨 | 涨占比 >65% 且均值 >1% |
| 5 | 偏强上涨 | 涨占比 >58% |
| 4 | 温和上涨 | 涨占比 >55% |
| 2 | 微涨 | 涨占比 >52% |
| 0 | 基本无波动 | 涨跌接近各半，幅度 <2% |
| -2 | 微跌 | 涨占比 <48% |
| -4 | 温和下跌 | 涨占比 <40% |
| -5 | 偏弱下跌 | 涨占比 <38% |
| -6 | 普跌 | 涨占比 <35% |
| -7 | 明显下跌 | 涨占比 <30% |
| -8 | 强势下跌 | 涨占比 <25% |
| -10 | 普遍强势下跌 | 涨占比 <15% |

**market_state.description**：直接使用脚本 `.btc_kline_6h.description` 或基于 K 线蜡烛微调。

#### 4.2 确定板块描述

脚本已生成每个板块的 `description`（如"FET+4.8%居前，多数上涨"）。确认准确后直接使用，必要时补充具体币种涨跌数据。

#### 4.3 衍生品数据（只陈述事实）

脚本已提取：`funding_rate_pct`、`funding_status`、`oi_contracts`、`ls_ratio`、`ls_status`。直接使用。

> ⛔ 禁止解读为"多头加仓看好后市"等推断。

#### 4.4 新闻（只列事实）

从 web_search 结果中摘取标题，标注归类和市场反应。不推断因果。

---

### 5. 保存输出

#### 5.1 Markdown 报告 → `market-brief/reports/YYYY-MM-DD-HHMM.md`

**模板（严格遵循）：**

```markdown
# 市场快报 YYYY-MM-DD HH:MM

## 市场状态
近6小时xxxxxxxxxxxxx。
市场评分：X（xxxx）

## 主流表现
- BTC：$XX,XXX，24h +X.X%（6h +X.X%）
- ETH：$X,XXX，24h +X.X%
- SOL：$XXX，24h +X.X%
- BNB：$XXX，24h +X.X%
- XRP：$X.XX，24h +X.X%

## 板块动态
（按涨跌幅排序）

- 🟢 xxxx板块 +X.X%：xxxxxxxxxx
- 🟡 xxxx板块 -X.X%：xxxxxxxxxx
- 🔴 xxxx板块 -X.X%：xxxxxxxxxx

> 🟢=上涨 🟡=横盘 🔴=下跌

## 涨跌榜
### 涨幅前 10
| 币种 | 板块 | 24h涨幅 |
|------|------|---------|
| XXX | AI | +XX% |

### 跌幅前 10
| 币种 | 板块 | 24h跌幅 |
|------|------|---------|
| XXX | Meme | -XX% |

## 市场情绪
恐惧贪婪指数：XX（xxxxx），较前一日 XX（xxxxx）→ xxxx

## BTC 衍生品
- 资金费率：X.XXXX%（xxxx）
- 持仓量：XXXX 万张
- 多空人数比：X.XX（xxxx）

## 近期新闻
1. 【xxxx】xxxxxxxxxx | 归类：xxxx | 市场反应：xxxx

---

*下次快报：YYYY-MM-DD HH:MM*
```

#### 5.2 结构化 JSON → `market-brief/data/YYYY-MM-DD-HHMM.json`

**直接从 `processed.json` 映射，补充 news 字段。Schema：**

```json
{
  "timestamp": "ISO8601",
  "market_state": {
    "description": "自由文本，近6小时走势",
    "score": -8
  },
  "fear_greed": {
    "current": 25,
    "category": "极度恐惧",
    "trend": "恶化",
    "prev_value": 34
  },
  "btc_summary": {
    "price": 75673.0,
    "change_24h_pct": -1.2,
    "change_6h_pct": -0.9,
    "description": "近6小时温和下行，尾盘收于低点附近"
  },
  "top_movers": {
    "gainers": [{"coin":"XXX","sector":"AI","change_pct":6.5}],
    "losers": [{"coin":"YYY","sector":"Meme","change_pct":-8.2}]
  },
  "sectors": [
    {
      "name": "L1 竞争链",
      "score": -4,
      "description": "SOL-1.2%领跌，多数下跌",
      "avg_change_pct": -1.05,
      "up_count": 5,
      "down_count": 18,
      "representatives": ["SOL","TON"],
      "top_gainer": {"coin":"TRX","change_pct":0.5},
      "top_loser": {"coin":"SOL","change_pct":-1.2}
    }
  ],
  "btc_derivatives": {
    "funding_rate": 0.0072,
    "funding_status": "温和偏多",
    "oi_value": 336,
    "oi_status": "持平",
    "ls_ratio": 1.27,
    "ls_status": "偏多"
  },
  "recent_news": [
    {
      "title": "新闻标题",
      "category": "监管/地缘/宏观/行业/安全/其他",
      "market_reaction": "未明显反应/相关币种XX异动+X%"
    }
  ]
}
```

---

### 6. 记录完成

```bash
NOW=$(date '+%Y-%m-%d %H:%M:%S')
echo "[$NOW] [市场快报] 报告已保存: market-brief/reports/...md" >> logs/market-brief.log
echo "[$NOW] [市场快报] 数据已保存: market-brief/data/...json" >> logs/market-brief.log
echo "[$NOW] [市场快报] ========== 生成完成 ==========" >> logs/market-brief.log
```

---

## 辅助脚本

| 脚本 | 用途 |
|------|------|
| `scripts/market-brief-collect.sh` | 数据采集主入口：curl 并行获取 → Python 加工 |
| `scripts/market-brief-process.py` | Python 数据处理：板块归类、评分、走势推断、输出 processed.json |

---

## Cron 配置

```bash
openclaw cron add \
  --name "market-brief" \
  --cron "30 22,6,14 * * *" \
  --tz "Asia/Shanghai" \
  --session isolated \
  --agent july \
  --message "根据 tasks/market-brief.md 生成市场快报。" \
  --timeout-seconds 300 \
  --model "deepseek/deepseek-v4-flash"
```

---

## 注意事项

1. **数据采集一体化**：`market-brief-collect.sh` 一次执行完成全部 API 请求和加工，减少 LLM tool call 轮次。
2. **板块映射维护**：`market-brief-process.py` 中的 `SECTORS` 字典与本文档板块表保持一致，修改时同步更新。
3. **新闻时效**：web_search 限制 24 小时内。
4. **独立性**：每份快报独立生成，不读取历史快报。
5. **板块映射定期核查**：OKX 会上下架币种，每月检查一次映射覆盖率。
