# 山寨币分析流程 v2 改进规划

> 基于 2026-06-03 观望周期审计发现
> 85% 活跃周期无持仓，根本原因：缺挂单能力 + 支撑位无质量评估 + 无限期等待

---

## 改进 1：挂单操作（pending order）

### 问题

当前 stage3 只能执行**市价立即开仓**。模型的 `entry_condition` 如果不是 `"immediate"`，stage3 直接跳过。这导致：

- 模型判断「$0.095 是好入场价」→ 但无法挂单，只能等
- 等到价格真的到 $0.095，模型已经不在那个报告里了
- 下一次报告可能价格又变了，模型继续犹豫

**本质**：开仓决策留在模型手里，但模型只在报告生成时存在。价格到达触发位时，模型不在场。

### 方案

新增 `action: "pending"`（挂单开仓），由 stage3 在 OKX 挂限价单。

#### 数据流

```
阶段二（模型）
  → trade-decision.json: action="pending", direction, limit_price, nominal_base, stop_loss, tp1, tp2, tp1_ratio
  → 阶段三（脚本）
    → 计算 sz = nominalFinal / (limit_price × ctVal)  ← 用挂单价算
    → okx swap place --ordType limit --px <limit_price> --sz <sz> ...
    → 写入 pending_entry.json（记录计划 TP/SL）
    → 日志: 💰 PENDING 挂单成功
  → 下一份报告
    → sync-alt-positions.js 检测到持仓
    → 模型输出 action="adjust" → 阶段三挂 OCO
```

#### 修改点

| 文件 | 改动 |
|------|------|
| `tasks/pipeline/stage2-alt.md` | 增加 `action: "pending"` + 新字段 `limit_price` 的说明 |
| `tasks/pipeline/stage2-zhuang.md` | 同上 |
| `scripts/stage3-executor.js` | 新增 `executePending()` 函数 |
| `tasks/pipeline/stage2-alt.md` | 增加「挂单后持仓检测」提醒：下份报告如果检测到持仓 → 自动选 `adjust` |

#### trade-decision.json 新增字段

```json
{
  "action": "pending",
  "direction": "long",
  "limit_price": 0.095,
  "nominal_base": 30,
  "stop_loss": 0.085,
  "take_profit1": 0.11,
  "take_profit2": 0.125,
  "tp1_ratio": 50,
  "trailing_callback_ratio": null,
  "observation_conditions": [],
  "pending_note": "挂单原因：0.095 是 4H 布林下轨 + 0.618 fib 收敛位，限价优于市价"
}
```

#### stage3 executePending() 伪代码

```javascript
async function executePending(direction, limitPrice, nominalFinal, sl, tp1, tp2, tp1Ratio) {
  // 1. 获取合约信息
  // 2. 用 LIMIT PRICE 算 sz（不是 market price）
  const rawSz = nominalFinal / (limitPrice * ctVal);
  sz = alignToLot(rawSz);

  // 3. 挂限价单
  okx swap place --instId ${INST_ID} --side ${side} --ordType limit --px ${limitPrice} --sz ${sz} --tdMode cross --posSide ${posSide}

  // 4. 写入 pending_entry.json（记录计划 TP/SL，供后续参考）
  writePendingEntry({ limitPrice, sl, tp1, tp2, tp1Ratio, ordId, sz, placedAt, direction });
}
```

---

## 改进 2：支撑/阻力位质量评级

### 问题

分析师在报告中看到的每个 MA、每个 Fib 回撤位、每个整数关口都被当作有效支撑/阻力，导致：

- 「价格在 $0.067 有支撑（之前碰过一次）」和「价格在 $0.063 有强力支撑（5 次测试全部守住）」被同等对待
- 任何价位都可以被解释为「空间不足」，因为总有「下一个支撑/阻力在附近」
- 大量无效 S/R 占据了 observation_conditions

### 方案

引入 **S/R 质量四级评级**，全部嵌在阶段二的交叉验证环节。

#### 评级标准

| 等级 | 名称 | 判断标准 | 可信度 | 允许作为 |
|------|------|---------|--------|---------|
| **S** | 强支撑/阻力 | ≥3 次有效反弹或拒绝 + 每次触及K线反应明显（长影线/放量）+ 曾从另一方被测试过（翻转确认） | 0.9-1.0 | SL位、入场位、TP位 |
| **A** | 中等支撑/阻力 | 2 次有效反弹或拒绝 + K线反应明显 | 0.6-0.8 | 入场位、辅助 SL |
| **B** | 弱支撑/阻力 | 1 次触及有反应 + MA/Fib/VWAP 叠加但未经反复验证 | 0.3-0.5 | 仅辅助参考，不可作为主要入场理由 |
| **C** | 参考位 | 纯数学（MA7/EMA12 单线 / 0.618 fib / 整数关口），没有任何 K 线行为验证 | 0.0-0.2 | 不可用于任何开仓决策依据 |

#### 评级时必答三问

在阶段二分析中引用任何 S/R 价位时，必须回答：

1. **触几次了？** — 这个价位被价格触及了多少次？
2. **什么反应？** — 每次触及 K 线给出了什么反应（长下影/长上影/放量吞噬/假突破/无反应）？
3. **是否翻转？** — 这个价位有没有从支撑变阻力（或反之）过？哪一次？是什么级别的 K 线确认的？

#### 规则约束

- **SL 必须设置在 S 或 A 级价位之外**。用 B/C 级价位做 SL = 无效止损
- **TP 如果是 C 级价位**，必须在报告中显式标注「TP 价位缺乏行为验证，仅作参考」
- **B 级价位不能单独作为 entry condition**。必须配合至少一个 A 级或 S 级价位
- **「整数关口」默认为 C 级**，除非有 K 线行为验证（≥2 次触及有反应 → 升级至 B 或 A）

#### 修改点

| 文件 | 改动 |
|------|------|
| `tasks/pipeline/stage2-alt.md` | 在「前置 B：多义信号交叉解读」后增加「前置 C：关键价位质量评估」 |
| `tasks/pipeline/stage2-zhuang.md` | 同上 |
| trade-decision.json | 无需改动（SR 评级在报告文本中体现，约束分析质量） |

---

## 改进 3：强制方向承诺 + 24h 过期 + 冷却机制

### 问题

- 大量周期是「双向等待」——同时列出做多和做空的条件，永远等不到
- 周期无限存活，INIT 8 篇报告 23 小时还在 wait
- 没有「机会过期」的概念

### 方案

#### 3.1 第一篇报告强制方向承诺

阶段一完成后 → 阶段二的第一篇报告（`report-001`）必须：

1. 基于阶段一数据 + 当前市场结构，给出**方向倾向**：
   - `bullish` → 只列做多触发条件
   - `bearish` → 只列做空触发条件
2. **如果不能给出方向倾向 → 直接输出 `action: "archive"`**（新 action），阶段三归档周期 + 写入冷却

```
方向判断矩阵：
- 多空信号差 ≥ 3 且有利方向有 ≥ 2 个高置信度信号 → 可以定向
- 多空信号差 < 3 或有利方向高置信度信号 < 2 → 无法定向 → archive
```

#### 3.2 24 小时超时自动归档

阶段二报告生成时检查：

```
IF 周期创建时间 > 24 小时前
   AND 当前无持仓
   AND 上一份报告 decision = "wait"
   AND 本次分析仍然无法给出可行的 entry condition
THEN action = "archive"
     reject_reason = "24h超时无入场机会，机会窗口已关闭"
```

**例外**：如果 24h 时 observation_conditions 中有条件即将触发（如价格已进入入场区间 ±1%），可以延长至 36h。

#### 3.3 冷却机制

归档的币种自动写入冷却名单。

**新增文件**：`data/coin-cooldown.json`

```json
{
  "_schema": "自动冷却名单。周期因无机会归档后，冷却期内 scanner 跳过该币种",
  "entries": {
    "INIT": { "cooldown_until": "2026-06-06T12:00:00+08:00", "reason": "24h超时无入场机会", "archived_cycle": "alt-INIT-20260602-1230" },
    "YB": { "cooldown_until": "2026-06-06T02:00:00+08:00", "reason": "无方向倾向", "archived_cycle": "alt-YB-20260602-0200" }
  }
}
```

**冷却规则**：
- 归档原因 = 无方向倾向或 24h 超时 → 冷却 **72 小时**
- 归档原因 = 止盈/止损完成 → 冷却 **24 小时**（等新结构形成）
- scanner-runner.sh 在 `window_scan` 阶段检查冷却名单
- 冷却期内的币种即使扫描命中也跳过

#### 3.4 报告降频

连续 3 篇 `wait` + 无持仓 → 报告间隔从 1h 拉长到 4h。

连续 6 篇 `wait` + 无持仓 → 报告间隔拉长到 12h，同时在下份报告生成时检查是否该归档。

> 实现：在 dispatch.js 提交任务时检查该周期的 wait 连续次数，动态调整 priority 和间隔。

#### 3.5 修改点汇总

| 文件 | 改动 |
|------|------|
| `tasks/pipeline/stage2-alt.md` | + 第一篇报告方向承诺规则 + 24h 超时规则 + action: "archive" 定义 |
| `tasks/pipeline/stage2-zhuang.md` | 同上 |
| `scripts/stage3-executor.js` | + 处理 `action: "archive"` → 调用 archive-cycle.js |
| `scripts/scanner-runner.sh` | + 冷却名单检查 |
| `scripts/archive-cycle.js` | + 归档后自动写入 coin-cooldown.json |
| `data/coin-cooldown.json` | 新建 |
| `scripts/dispatch.js` | + 动态降频逻辑（连续 wait 计数 → 调整间隔） |

---

## 实施优先级

| 优先级 | 改进项 | 预期效果 | 工作量 |
|--------|--------|---------|--------|
| 🔴 P0 | 3.1 强制方向承诺 + 3.2 24h 超时 | 直接消除 60% zombies，当前 51 个空仓周期至少归档 30+ | 中（改 2 个 stage2 文件 + stage3 加 archive action） |
| 🟡 P1 | 2. SR 质量评级 | 提高剩余周期的分析质量，减少「假支撑真噪音」 | 中（改 2 个 stage2 文件，加 S/R 评级规范） |
| 🟢 P2 | 1. 挂单操作 | 让有方向的周期能实际执行，提高 15%→目标 40% 执行率 | 大（改 stage2 ×2 + stage3 + 持仓检测逻辑） |
| 🔵 P3 | 3.3 冷却机制 | 防止刚归档的币立刻又被 scanner 捡回来 | 小（改 scanner-runner + 新建 cooldown.json） |
| ⚪ P4 | 3.4 报告降频 | 减少已观望周期的资源消耗 | 小（改 dispatch.js） |

### 建议落地顺序

**第一批（立即）**：P0 → 最短时间消灭最多僵尸
**第二批（随后）**：P1 + P3 → 提高分析质量 + 防复发
**第三批（本周内）**：P2 + P4 → 执行能力 + 资源优化
