# BTC 走势展望任务

此任务独立于日报，专注产出短期 BTC 走势预测，供山寨币阶段二分析使用。

---

## 触发方式

- 定时任务，每 4 小时一次（00:00 / 04:00 / 08:00 / 12:00 / 16:00 / 20:00 GMT+8）
- 由 cron 创建隔离会话执行

---

## 数据获取

直接使用以下脚本获取数据，无需认证：

```bash
# K线 + 技术指标（多时间框架：15m/1H/4H/1D）
node skills/btc-market-lite/scripts/get_enhanced_analysis.js --json --save
```

如需补充数据，可用 curl 通过代理直接调 OKX 公开 API：

```bash
# 当前价格 + 24H 统计
curl -s --max-time 10 --proxy "${PROXY_URL:-http://127.0.0.1:7890}" \
  "https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT-SWAP"

# 订单簿
curl -s --max-time 10 --proxy "${PROXY_URL:-http://127.0.0.1:7890}" \
  "https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=25"

# 资金费率
curl -s --max-time 10 --proxy "${PROXY_URL:-http://127.0.0.1:7890}" \
  "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP"

# OI
curl -s --max-time 10 --proxy "${PROXY_URL:-http://127.0.0.1:7890}" \
  "https://www.okx.com/api/v5/public/open-interest?instId=BTC-USDT-SWAP"
```
包括但不限于以上数据获取方法，你可以根据需求灵活获取。

---

## 分析要求

基于以上数据，对 BTC 未来 **4H** 和 **24H** 的走势分别给出判断。你的分析应经历思考但**最终只输出 JSON**，不输出其他内容。

### 五档评分标准

**强烈上涨**：
- 关键阻力已被有效突破且通过右侧确认（突破后回踩不破、或突破后继续走高）
- 上升趋势已实质形成，不是假突破
- 未来该时间框架内极大可能延续上涨趋势
- 触发条件示例：放量突破关键阻力 + 回踩确认支撑有效 + 更高高点/更高低点结构

**可能上涨**：
- 价格接近关键阻力位，有突破的预期但尚未完成
- 上涨动能正在积聚（如缩量横盘后放量试探、OI 配合增长）
- 趋势尚未形成，存在假突破或冲高回落的风险
- 触发条件示例：接近阻力 + 多空比偏多 + 资金费率中性 + 下跌缩量

**无明确信号**：
- 横盘震荡，缺乏方向性
- 多空力量在当前区间均衡
- 无法判断未来方向，区间内随机波动为主

**可能下跌**：
- 价格接近关键支撑位，有跌破的风险但尚未确认
- 下跌动能正在积聚（如反弹缩量、OI 下降、资金费率转负）
- 趋势尚未形成，存在支撑反弹或假跌破的可能
- 触发条件示例：接近支撑 + 反弹无力 + 卖压增加 + 恐慌情绪上升

**强烈下跌**：
- 关键支撑已被有效跌破且通过右侧确认（跌破后反弹不破、或跌破后继续走低）
- 下降趋势已实质形成，不是假跌破
- 未来该时间框架内极大可能延续下跌趋势
- 触发条件示例：放量跌破关键支撑 + 反弹确认阻力有效 + 更低低点/更低高点结构

### ⚠️ 关键约束

**右侧确认**：强烈上涨/下跌必须在盘面上找到了右侧确认证据——突破/跌破不是单根 K 线影线，而是收盘确认。没有右侧确认的，降级为「可能」档。

**4H 与 24H 可以不同**：4H 可能强烈下跌（刚刚跌破），但 24H 可能只是可能下跌（日线支撑仍在）。这不矛盾，如实反映。

**置信度体现在档位里**：不需要额外的置信度字段。用哪一档已经表达了你的判断确信程度。

---

## 输出

**只输出以下 JSON，不要其他文字。**

```json
{
  "generated_at": "ISO8601",
  "btc_price": 当前价格,
  "outlook_4h": {
    "grade": "strong_bullish | likely_bullish | neutral | likely_bearish | strong_bearish",
    "reason": "简洁理由，1-2句话",
    "key_levels": { "support": 支撑位, "resistance": 阻力位 }
  },
  "outlook_24h": {
    "grade": "strong_bullish | likely_bullish | neutral | likely_bearish | strong_bearish",
    "reason": "简洁理由，1-2句话",
    "key_levels": { "support": 支撑位, "resistance": 阻力位 }
  }
}
```

保存到 `data/btc-outlook.json`（覆盖写入）。

```bash
# 写入后记录日志
TS=$(TZ='Asia/Shanghai' date '+%Y-%m-%d %H:%M:%S')
echo "[$TS] [BTC展望] 4H=$(jq -r .outlook_4h.grade data/btc-outlook.json) | 24H=$(jq -r .outlook_24h.grade data/btc-outlook.json)" >> logs/btc-outlook.log
```
