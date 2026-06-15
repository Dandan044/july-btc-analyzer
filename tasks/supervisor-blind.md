# 独立市场评估（盲测）

你收到了一个交易审查请求。在接触任何分析报告之前，你需要用自己的数据独立判断这个市场。

## 背景

- **币种**：{COIN}
- ⚠️ 你不知道七月想做什么操作——这是故意设计的。你需要完全基于自己的市场判断，给出你会怎么操作。

## BTC 市场环境

在做出独立判断之前，先建立对宏观环境的认知。读取两份 BTC 数据：

```bash
# BTC 4H/24H 走势展望（五档评分 + 关键价位）
cat data/btc-outlook.json

# 该币种对 BTC 的多框架跟踪度
cat active/{CYCLE_DIR}/data-context/btc-tracking.json
```

这两份数据不会透露七月的决策——它们只描述 BTC 的走向和该币种的历史跟踪特征。但你需要在独立判断时将它们纳入考量：当前 BTC 是什么趋势？这个币种历史上怎么跟 BTC 走？如果 BTC 处于明确的方向中，这个币种的独立走势能脱离 BTC 多远？

## 你的任务

基于你对当前市场的独立判断，回答：

> 这个币种，现在，我会怎么操作？

你需要给出明确的结论：
- **方向**：做多 / 做空 / 观望
- **操作**：开仓 / 等待 / 不加仓
- **核心理由**：支撑你判断的关键数据点

## 你能用的

- `okx` CLI 工具可获取 OKX 市场数据
- `data/btc-outlook.json` — BTC 4H/24H 走势展望
- `active/{CYCLE_DIR}/data-context/btc-tracking.json` — 该币种对 BTC 的跟踪度（corr+Beta+下行半相关）
- 你可以根据需要自行选择获取什么数据、多少数据、什么粒度
- 你可以分步探索——先看概览，发现值得深挖的方向再深入

## 你不能做的

- 不要读任何分析报告或 trade-decision 文件——那些是你之后要审查的对象
- 不要读 `data-context/supervisor-intent.json`——那是七月的实际决策，审查阶段才揭晓
- 不要预设结论——你唯一的依据是你自己获取的市场数据

## 输出

将你的独立判断写入该币种的周期日志，然后读 `tasks/supervisor-review.md` 进入下一阶段。

```bash
TS=$(TZ='Asia/Shanghai' date '+%Y-%m-%d %H:%M:%S')
echo "[$TS] [监督者] ========== 审查开始 ==========" >> logs/alt-{COIN}-process.log
echo "[$TS] [监督者] [盲测] 独立判断: 方向=X | 操作=X | 理由: ..." >> logs/alt-{COIN}-process.log
```
