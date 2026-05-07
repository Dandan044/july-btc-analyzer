# 山寨币数据获取层：调研报告

> 调研日期：2026-05-06
> 状态：方案已整理，待实施

---

## ✅ 立即可用（已验证通过代理连通）

| 数据源 | 类型 | 语言 | 用途 | 实测 |
|--------|------|------|------|------|
| **Cointelegraph RSS** | 新闻 | EN | 主流加密媒体头条 | 200 OK, 58KB |
| **CoinDesk RSS** | 新闻 | EN | 深度分析/政策 | 200 OK, 31KB |
| **CoinGecko Trending** | 排行 | Multi | 全币种热搜榜(山寨发现) | 200 OK, 55KB, 无需Key |
| **CoinGecko Markets** | 行情 | EN | 全币种排行/涨跌 | 200 OK, 无需Key |
| **CoinGecko Global** | 宏观 | EN | 总市值/占比/24h变化 | 200 OK, 无需Key |
| **CoinGecko Categories** | 分类 | EN | 板块热度 (DeFi/Meme/AI等) | 200 OK, 无需Key |

### 端点详情

```
# CoinGecko (无需API Key, 免费)
https://api.coingecko.com/api/v3/search/trending
https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=50&page=1
https://api.coingecko.com/api/v3/global
https://api.coingecko.com/api/v3/coins/categories

# RSS 新闻 (需代理 127.0.0.1:7890)
https://cointelegraph.com/rss
https://www.coindesk.com/arc/outboundfeeds/rss/
```

---

## ⚠️ 需简单配置（免费）

| 数据源 | 类型 | 配置 | 价值 |
|--------|------|------|------|
| **CryptoPanic** | 新闻聚合+情绪 | 注册免费API Key | 聚合上百家媒体+KOL，有看涨/看跌投票情绪 |
| **PANews CLI** | 中文新闻 | 安装@panews npm包 | 快讯/深度/专题/热搜/必读，结构化JSON |

### CryptoPanic 接入方式

1. 注册：https://cryptopanic.com/developers/api/keys
2. 免费层支持获取 posts（新闻聚合）+ 情绪投票数据
3. 代理访问：需通过 `127.0.0.1:7890`
4. Node.js 客户端：https://github.com/roccomuso/cryptopanic

```
# API 格式
https://cryptopanic.com/api/v1/posts/?auth_token=YOUR_TOKEN&public=true
```

### PANews 接入方式

1. GitHub：https://github.com/panewslab/skills
2. CLI 命令：`node cli.mjs <command> [options]`
3. 支持命令：
   - `list-articles` — 最新文章列表
   - `get-daily-must-reads` — 每日必读
   - `get-rankings` — 热门排行 (daily/weekly)
   - `search-articles` — 关键词搜索
   - `get-article` — 获取文章全文
   - `list-topics` / `get-topic` — 社区话题
   - `list-events` / `list-calendar-events` — 活动日历
   - `get-hooks` — 平台精选/热搜
   - `list-polymarket-boards` — 聪明钱排行榜

---

## ❌ 不适用或需付费

| 数据源 | 原因 |
|--------|------|
| Odaily RSS | 返回HTML页面，非RSS XML |
| 金色财经 | 无公开API |
| Foresight News API | Cloudflare 567拦截，不可用 |
| LunarCrush API | 付费API |
| CoinMarketCap Trending | 需要API Key (付费) |
| CoinGlass API | 需要API Key (付费) |
| cryptocurrency.cv | 部署暂停 (Deployment Paused) |

---

## 🎯 KOL 喊单获取方案

纯 KOL 喊单追踪是最难的部分。Twitter/X API 太贵，Telegram 频道需人工维护。替代方案：

1. **CryptoPanic** — 聚合社交平台（含Twitter KOL）的讨论并按涨跌情绪打分，这是最接近"KOL 情绪"的免费数据源
2. **CoinGecko Trending** — 热搜榜本身就是 KOL 影响力的滞后指标，被喊多的币会上榜
3. **`web_search` 工具** — 七月已内置 DuckDuckGo 搜索，可搜索 "BTC 喊单" "山寨币 KOL" 等关键词，虽不结构化但能捕捉突发信息
4. **PANews 热搜/必读** — 中文圈 KOL 观点的聚合

---

## 📋 建议实施优先级

### P0 — 零成本、已连通（可立即接入日报）
- CoinGecko Trending → 山寨热搜发现
- Cointelegraph/CoinDesk RSS → 重大消息摘要
- 统一数据获取脚本 `scripts/fetch_news.sh`

### P1 — 需简单配置（1-2天完成）
- 注册 CryptoPanic 免费 API Key → 聚合新闻+情绪
- 安装 PANews CLI → 中文快讯

### P2 — 后续评估
- LunarCrush 付费版（山寨分析需求增大时）
- Santiment（链上+社交综合指标）

---

## 🔧 现有可用工具

七月已经具备的工具，可直接用于山寨币信息获取：

| 工具 | 用途 |
|------|------|
| `web_search` (DuckDuckGo) | 搜索任何新闻/KOL讨论 |
| `kimi_search` | 备用搜索引擎 |
| `web_fetch` / `kimi_fetch` | 抓取网页内容 |
| OKX Rubik API | 多空比/Taker买卖比/持仓量（已在日报中使用） |
| OnchainOS CLI | 链上数据（持有人分布/风险评级/集群分析） |

---

## 📝 网络注意事项

- 所有国外 API 需通过代理 `127.0.0.1:7890` (Mihomo)
- OKX Public API 安全阈值：≤ 5 req/s，短窗口 40-50 请求后触发 429
- CoinGecko Public API：约 10-30 次/分钟，无需 API Key
- RSS 抓取建议频率：5-10 分钟一次
