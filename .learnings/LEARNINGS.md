# LEARNINGS.md

## [LRN-20260328-001] correction - 止盈止损判断混淆

**Logged**: 2026-03-28T09:59:00+08:00
**Priority**: critical
**Status**: pending
**Area**: backend

### Summary
混淆"支撑跌破"与"止盈触发"，导致错误归档周期

### Details
**错误场景**：
- 27日最低价：$65,501
- 止盈2目标：$65,000
- 错误判断：$65,501 触及止盈 $65,000 → 周期归档

**实际逻辑**：
- 止盈触发条件：**最低价 ≤ 止盈价**
- $65,501 > $65,000，差距 $501
- 止盈2 **未触发**

**混淆的概念**：
| 概念 | 含义 | 判断方式 |
|------|------|---------|
| 支撑跌破 | 价格跌破支撑位 | 最低价 < 支撑价 |
| 止盈触发 | 价格触及止盈目标 | 最低价 ≤ 止盈价 |

这两个概念完全不同，不可混用！

### Suggested Action
1. 在 `tasks/daily-report.md` 中添加明确的止盈止损检查规则：
   ```
   止盈触发：最低价 ≤ 止盈价
   止损触发：最高价 ≥ 止损价
   ```
2. 归档前必须核对：确认价格是否真正触发止盈/止损
3. 添加到周期归档检查清单

### Metadata
- Source: user_feedback
- Related Files: tasks/daily-report.md, active/cycle-*/trade-suggestions.json
- Tags: 止盈止损, 周期归档, 逻辑错误
- Pattern-Key: logic.stoploss_takeprofit_confusion
- Recurrence-Count: 1
- First-Seen: 2026-03-28
- Last-Seen: 2026-03-28

---

## 2026-03-20 | 交易方向偏向问题

**问题：** 分析报告中总是偏向做多，从未给出正式的做空建议。

**证据：**
- "做多/多单"提及 4 次，正式做空建议 0 条
- 做空只作为口头备选提及，未进入交易建议表格

**根因：**
1. 规则提醒存在，但未强制执行
2. 分析框架缺少做空触发条件检查清单
3. 可能存在"做多偏好"认知偏差

**改进：**
1. 在分析流程中加入**双向条件检查**：
   - 做多条件：支撑企稳、反弹信号、情绪修复
   - 做空条件：压力受阻、下跌信号、情绪恶化
2. 每次报告必须回答：当前更适合做多还是做空？
3. 当趋势明确向下时，优先考虑做空建议
## 2026-04-29: 警报器假突破问题与延迟确认方案

**问题：** 多价位警报规则没有延迟确认机制，价格在 K 线影线中短暂触及价位就立即触发分析。今天 4 次触发中有多次是假突破（摸了一下就弹回来），导致：
1. 浪费分析资源（频繁的即时分析）
2. 模型误判（报告里写着"突破"但实际只是影线）
3. 在 15:00 触发时报告建议减仓，最终全平了仓位（同时暴露了 swap close 的 bug）

**根因：** 多价位规则模板（set-alert.md §12）的 check() 是从 K 线区间高低价判断触及，但没有 waiting/confirmation 阶段，碰到就触发。

**解决方案：**
1. 新增 §13 延迟确认多价位规则模板，每个价位带 `confirmPolicy` 和 `confirmMs`
2. 确认策略四级：instant(0min) / touch(3-5min) / hold(10-20min) / deep_hold(20-30min)
3. 稳定性检查：延迟期间持续监控价格是否回穿，回穿超过 0.1% 则重置计时
4. 触发元数据增强：传递 firstTouchTime、elapsedMs、stability 等给即时分析
5. 阶段四新增 B.5.5"分配价位确认策略"步骤，创建规则时强制选择策略
6. 阶段四自查清单新增"延迟确认核对"章节

**关键原则：**
- SL 用 instant（不能延迟止损）
- TP 用 touch（短暂确认）
- 入场触发位用 hold（假突破高发区，必须站稳）
- 整数关口 / 远处观测位用 deep_hold（不急）

## 2026-05-01: 警报规则 lifetime() 必须是字符串，不是 boolean

**来源**: 排查无限重载循环时发现（ERRORS.md 5月1日记录）

**核心教训**: 创建警报规则时，`lifetime()` 必须返回 `'active'` / `'expired'` / `'completed'` 字符串。
返回 boolean 会导致引擎将其误判为过期 → 无限加载-卸载循环（引擎判断 `true !== 'active'`）。

**自检**: 任何新创建的 `.js` 规则文件，检查 `lifetime()` 的 `return` 语句后是否有 `? 'active' : 'expired'`。

---

## 2026-04-30: Web Search 多引擎配置

### 背景
原有的 Kimi (Moonshot) web_search 出现 401 认证失败，需要替换搜索引擎。

### 发现
1. OpenClaw 支持 11 种搜索引擎：DuckDuckGo（免费）、Brave、MiniMax、SearXNG 等
2. `tools.web.search.provider` 是受保护配置路径，只能通过直接编辑 JSON + 重启修改
3. web_search 不支持多 provider 自动 fallback，只有单 provider 模式
4. DuckDuckGo 是免费的内置插件，provider ID 为 "duckduckgo"
5. 国内环境 DuckDuckGo 需走代理，需在 systemd service 中注入代理环境变量

### 最终方案
- **主力**: DuckDuckGo（免费、精准、中英文覆盖）
- **备用**: MiniMax（国内直连、有 API Key 已配置）
- 切换需手动改 config + restart
