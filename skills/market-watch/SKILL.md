# Market Watch — 市场观测器

WebSocket 驱动的轻量级市场监控引擎。

## 定位

与 `btc-alert` 引擎并行运行，互补关系：

| | btc-alert | market-watch |
|---|---|---|
| 数据源 | REST 轮询 | WebSocket 推送 |
| 触发条件 | 规则文件自定义（价位/指标） | 简单阈值（价格/OI/费率变动） |
| 规则生命周期 | 一次性，触发即归档 | 持久，触发后重置基线 |
| 配置 | 每个币种一个 .js 规则文件 | 一个 config.json |

## 工作原理

```
WebSocket 订阅 → 数据推送 → 内存存储 → 对比基线 → 超阈值 → stage1-instant → 调度器 → LLM 分析
```

## 触发条件

- **价格变动** ≥ 阈值%（默认 3%，可逐币种覆盖）
- **OI 变动** ≥ 阈值%（默认 3%）
- **资金费率变动** ≥ 阈值（默认 0.5%）

阈值配置在 `config.json`，支持 per-coin 覆盖。

## 启动

```bash
pm2 start skills/market-watch/engine.js --name market-watch
pm2 save
```

## 日志

`logs/market-watch.log`
