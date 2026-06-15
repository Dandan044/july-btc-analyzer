# P0 实施规划：方向承诺 + 24h 超时 + 冷却

> 只改 alt 流程，不动 zhuang 流程
> 规划日期：2026-06-03

---

## 改动范围总览

| # | 文件 | 改动类型 | 说明 |
|---|------|---------|------|
| 1 | `tasks/pipeline/stage2-alt.md` | 新增章节 | 步骤 4.5「周期状态检查」 |
| 2 | `tasks/pipeline/stage2-alt.md` | 修改 | 步骤 6 决策原则增加 archive 规则 |
| 3 | `tasks/pipeline/stage2-alt.md` | 修改 | 步骤 8 trade-decision 增加 `archive` action |
| 4 | `scripts/stage3-executor.js` | 新增逻辑 | 处理 `action: "archive"` |
| 5 | `data/coin-cooldown.json` | 新建 | 冷却名单存储 |
| 6 | `scripts/archive-cycle.js` | 新增参数 | `--cooldown-hours` + 写入 coin-cooldown.json |
| 7 | `scripts/scanner-full.py` | 修改 | 读取 cooldown 名单并跳过 |

---

## 改动 1：新增「步骤 4.5：周期状态检查」

**文件**：`tasks/pipeline/stage2-alt.md`
**位置**：步骤 4「历史回顾」之后，步骤 6「交叉验证分析」之前（约第 183 行）

### 新增内容

```markdown
---

### 步骤 4.5: 周期状态检查

⚠️ **在进入交叉验证分析之前，先检查周期是否应该继续。**

此步骤决定本周期是继续分析还是直接归档。只有通过此检查，才能进入步骤 6 的完整分析。

#### 4.5.1 首周期方向承诺

如果你是**首周期**（`history_reports.total_count == 0`，即本周期暂无历史报告）：

在完成前置 A（信号枚举）后，统计信号分布：
- 利多信号数 vs 利空信号数
- 高置信度（置信度标记为「高」）信号的分布

**决策矩阵：**

| 条件 | 动作 |
|------|------|
| 多空信号差 ≥ 3 且有利方向有 ≥ 2 个高置信度信号 | ✅ 选定方向，进入完整分析，**observation_conditions 只能朝此方向设置** |
| 多空信号差 < 3 或有利方向高置信度信号 < 2 | ❌ **直接归档**（见下方） |

> **选定方向后，禁止同时列做多和做空两套 observation_conditions。**
> 如果你选了 bullish，你只能列「在什么条件下做多」。如果选了 bearish，你只能列「在什么条件下做空」。双向等待 = 没有方向 = 机会不存在。

**归档时的 trade-decision.json：**
```json
{
  "action": "archive",
  "direction": null,
  "archive_reason": "首周期无法确定方向倾向",
  "archive_detail": "利多信号 N 条(高置信度 K 条) vs 利空信号 M 条(高置信度 J 条)，信号差不满足 ≥3 且高置信度不足 2 条，无法形成方向判断"
}
```

归档后写入冷却名单 72h。

#### 4.5.2 24 小时超时检查

如果你**不是首周期**，且当前无持仓（`positions.json` 当前持仓数 = 0）：

1. 计算本周期年龄：当前时间 - 周期创建时间（从 `data-manifest` 的 `coin.started_at` 或周期目录名解析）
2. 检查上一份 `trade-decision.json` 的 action

**决策矩阵：**

| 条件 | 动作 |
|------|------|
| 周期年龄 > 24h 且上一份 action = `wait` 且无 observation_condition 即将触发* | ❌ **直接归档** |
| 周期年龄 > 24h 且上一份 action = `wait` 但有 observation_condition 即将触发* | ⚠️ 延长 12h（即本次继续 wait，但下次报告仍需检查） |
| 周期年龄 ≤ 24h | ✅ 继续正常分析 |

> \* 「即将触发」定义：observation_condition 中的价格条件与当前价格距离 ≤ 2% 且方向正确（如等做多条件且价格确实在接近该区域）。

**归档时的 trade-decision.json：**
```json
{
  "action": "archive",
  "direction": null,
  "archive_reason": "24h超时无入场机会",
  "archive_detail": "周期已存在 XXh，共 Y 篇报告，始终无持仓。上一个 wait 决策的 observation_conditions 未触发，机会窗口已关闭。"
}
```

归档后写入冷却名单 72h。

#### 4.5.3 连续等待降级

如果周期年龄 ≤ 24h 且通过上述检查：

检查连续 `wait` 次数（读取最近 N 份 trade-decision.json 的 action）：

| 连续 wait 次数 | 行为 |
|---------------|------|
| 0-2 | 正常分析，无特殊处理 |
| 3-4 | 正常分析，但报告中需增加「机会可行性重评估」段落 |
| 5-6 | 报告仅需输出简化版——跳过完整前置 A/B，直接给出「是否需要归档」判断 |
| ≥ 7 | **直接归档**。「连续 7 次 wait 无结果，该机会已冷却」 |

#### 4.5.4 通过检查后的方向约束

如果本次继续分析（未归档），且本周期已有方向倾向（从上一份 trade-decision 的 direction 或 direction_bias 继承）：

- **observation_conditions 必须与已有方向一致**
- 如果市场结构发生了方向性变化（如从偏多转为偏空），必须在报告中显式说明变化原因，且观测条件只能朝新方向设置

**日志记录：**
```
[$NOW] [阶段二] 周期状态检查通过: {检查类型} | 年龄: {X}h | 连续wait: {Y}次 | 方向: {direction}
```

或

```
[$NOW] [阶段二] 周期归档: {reason} | 年龄: {X}h | 冷却: 72h
```
```

---

## 改动 2：修改步骤 6 决策原则

**文件**：`tasks/pipeline/stage2-alt.md`
**位置**：步骤 6 → 四、开仓策略 → 决策原则（约第 387 行）

### 当前内容

```
**决策原则：**
- 三维共振且方向明确 → 顺势开仓
- 驱动力衰减 + 反转信号累积 → 可选择左侧反向布局
- 信号矛盾或模糊 → 观望，列出观察条件
- 已有持仓但驱动逻辑反转 → 给出平仓指令
- **BTC 4H 和 24H 同时逆风 + 币种与btc强相关 → 这单的条件可能没到，观望比开仓更合理**
```

### 修改为

```
**决策原则（按优先级排序）：**

| 优先级 | 条件 | 动作 |
|--------|------|------|
| 🔴 P0 | 周期状态检查决定归档（步骤 4.5） | `action: "archive"` |
| 🟢 P1 | 三维共振且方向明确 | 顺势开仓（open 或 pending） |
| 🟢 P1 | 驱动力衰减 + 反转信号累积 | 可选择左侧反向布局 |
| 🟡 P2 | 信号矛盾或模糊 + 非首周期 | 观望，列出**单一方向的**观察条件 |
| 🟡 P2 | 已有持仓但驱动逻辑反转 | 给出平仓指令 |
| 🟡 P2 | BTC 4H 和 24H 同时逆风 + 币种与btc强相关 | 观望比开仓更合理，但也必须选定方向以便设置单向观察条件 |

> ⚠️ **首周期已通过 4.5.1 检查 → 方向已锁定。** 后续报告的 observation_conditions 必须与锁定方向一致。如果市场结构根本性逆转（不是微调），才能重新评估方向并说明原因。
```

---

## 改动 3：修改 trade-decision JSON 定义

**文件**：`tasks/pipeline/stage2-alt.md`
**位置**：步骤 8「输出开仓数据」（约第 650 行）

### 修改 action 字段枚举

当前：
```
| `action` | string | `open` / `add` / `reduce` / `close` / `adjust` / `hold` / `wait` |
```

改为：
```
| `action` | string | `open` / `add` / `reduce` / `close` / `adjust` / `hold` / `wait` / `archive` |
```

### 新增字段

在现有字段表中增加：

```
| `direction_bias` | string/null | `bullish` / `bearish`。首周期方向承诺时必填，记录锁定的方向 |
| `archive_reason` | string/null | 归档原因。action=archive 时必填 |
| `archive_detail` | string/null | 归档详细说明 |
| `wait_count` | number | 当前周期累计 wait 次数（含本次） |
```

### 新增字段选择规则

```
- `action = archive` → `archive_reason` 必填，`archive_detail` 推荐填写
- `action = wait` 且首周期 → `direction_bias` 必填
- `action = wait` 且非首周期 → `direction_bias` 从上一次继承，必须填写
- 所有 `action = wait` → `wait_count` 必填
```

### 新增完整 JSON 示例（archive）

```json
{
  "coin": "INIT",
  "pipeline_profile": "alt",
  "report_file": "alt-report-INIT-2026-06-03-1200.md",
  "action": "archive",
  "direction": null,
  "direction_bias": null,
  "archive_reason": "24h超时无入场机会",
  "archive_detail": "周期已存在 23.5h，共 8 篇报告，始终无持仓。上一份 wait 决策的 observation_conditions 未触发，机会窗口已关闭。",
  "wait_count": 8,
  
  "entry_condition": null,
  "nominal_base": null,
  "calc_position_input": null,
  "calc_position_output": null,
  "stop_loss": null,
  "take_profit1": null,
  "take_profit2": null,
  "tp1_ratio": null,
  "trailing_callback_ratio": null,
  "reject_reason": "24h超时无入场机会",
  "reduce_ratio": null,
  "observation_conditions": []
}
```

---

## 改动 4：stage3-executor.js 处理 archive action

**文件**：`scripts/stage3-executor.js`
**位置**：步骤 5 之后（约第 410 行），在现有 skip 逻辑之前

### 新增逻辑

在 `adjustedAction` 之后，`skipExecution` 之前插入：

```javascript
// ════════════════════════════════════════════
// 步骤 5.1: 处理直接归档请求
// ════════════════════════════════════════════
// 阶段二输出 action="archive" 时，直接归档，不执行交易操作
if (action === 'archive') {
  skipExecution = true;
  skipReason = `阶段二请求归档: ${archive_reason || '未指定原因'}`;
  adjustedAction = 'archive';
  log(`📦 ARCHIVE(阶段二): ${archive_reason || '未指定原因'}`);

  try {
    const reason = archive_reason || '阶段二分析决定归档';
    const detail = archive_detail || '';
    const by = 'manual'; // 阶段二主动归档

    // 使用统一的归档脚本
    const archiveCmd = `node "${ARCHIVE_SCRIPT}" --cycle ${CYCLE_DIR} --by ${by} --reason "${reason.replace(/"/g, '\\"')}" --close-type "手动归档"`;
    const archiveOut = execSync(archiveCmd, { encoding: 'utf8', timeout: 30000 });
    archived = true;
    log(`📦 ARCHIVE: ${CYCLE_DIR} → archived/ | 原因: ${reason}`);

    // 如果带了冷却标志，写入 coin-cooldown.json
    const cooldownHours = archive_reason?.includes('24h超时') || archive_reason?.includes('无法确定方向') ? 72 : 24;
    writeCooldown(COIN, cooldownHours, reason, CYCLE_DIR);
  } catch (e) {
    log(`📦 ARCHIVE 失败: ${e.message}`, 'ERROR');
  }
}
```

### 新增函数 writeCooldown

在文件末尾新增：

```javascript
function writeCooldown(coin, hours, reason, cycleDir) {
  const cooldownPath = path.join(WORKSPACE, 'data', 'coin-cooldown.json');
  let cooldown = {};
  try {
    if (fs.existsSync(cooldownPath)) {
      cooldown = JSON.parse(fs.readFileSync(cooldownPath, 'utf8'));
    }
  } catch (e) {}

  if (!cooldown.entries) cooldown.entries = {};
  
  const until = new Date(Date.now() + hours * 3600000).toISOString();
  cooldown.entries[coin] = {
    cooldown_until: until,
    reason: reason,
    archived_cycle: cycleDir || CYCLE_DIR,
    added_at: new Date().toISOString()
  };
  
  cooldown.updated = new Date().toISOString();
  fs.writeFileSync(cooldownPath, JSON.stringify(cooldown, null, 2) + '\n');
  log(`🧊 冷却: ${coin} → ${hours}h | 至 ${until}`);
}
```

### 注意

- `archive_reason` 需要从 decision JSON 中提取（当前第 373 行的解构需要增加此字段）
- 归档成功后跳过步骤 7/8/9，直接进入步骤 10 和 output

---

## 改动 5：新建 coin-cooldown.json

**文件**：`data/coin-cooldown.json`（新建）

```json
{
  "_schema": "自动冷却名单。周期因无机会归档后，冷却期内 scanner 跳过该币种。由 stage3-executor.js 的 writeCooldown() 自动维护。",
  "entries": {},
  "updated": null
}
```

---

## 改动 6：archive-cycle.js 增加冷却写入

**文件**：`scripts/archive-cycle.js`

**改动**：stage3 的 `action: "archive"` 处理中，直接在 stage3 内调用 writeCooldown，不需要改 archive-cycle.js。archive-cycle.js 保持不变。

> 但如果其他流程（如手动归档）也需要冷却，可以给 archive-cycle.js 加 `--cooldown-hours` 参数。P0 阶段暂不需要——stage3 直接处理即可。

---

## 改动 7：scanner-full.py 读取冷却名单

**文件**：`scripts/scanner-full.py`
**位置**：`window_scan` 函数（约第 300 行），在现有黑名单检查之后

### 新增逻辑

在 `spawn_cooldown` 检查（如果有的话）或紧接 `blacklist` 检查之后：

```python
# ═══ 冷却名单检查 ═══
COOLDOWN_PATH = os.path.join(WORKSPACE, "data", "coin-cooldown.json")

def load_cooldowns():
    try:
        with open(COOLDOWN_PATH, 'r') as f:
            data = json.load(f)
        entries = data.get('entries', {})
        now = datetime.now(timezone.utc)
        active = {}
        for coin, info in entries.items():
            until = datetime.fromisoformat(info['cooldown_until'].replace('Z', '+00:00'))
            if until > now:
                active[coin] = info
        # 清理过期条目
        if len(active) != len(entries):
            data['entries'] = active
            data['updated'] = now.isoformat()
            with open(COOLDOWN_PATH, 'w') as f:
                json.dump(data, f, indent=2)
        return active
    except:
        return {}

# 在 window_scan 中:
cooldowns = load_cooldowns()
for coin in list(candidates):
    if coin in cooldowns:
        c = cooldowns[coin]
        stats["cooldown"] += 1
        # 可选日志
        candidates.remove(coin)
```

### 统计增加

在 stats dict 中增加 `"cooldown": 0`。

---

## 数据流总览（P0 改动后）

```
scanner-full.py
  ├── 黑名单检查（已有）
  ├── 冷却名单检查（新增）← 改动 7
  ├── 活跃周期检查（已有）
  └── → stage1-prep.js → cron dispatch

阶段二（模型）
  ├── 步骤 4.5: 周期状态检查（新增）← 改动 1
  │   ├── 首周期方向承诺
  │   ├── 24h 超时检查
  │   └── 连续 wait 降级
  ├── 步骤 6: 交叉验证分析
  │   └── 决策原则更新（改动 2）
  ├── 步骤 8: trade-decision.json
  │   ├── action: "archive"（新增）← 改动 3
  │   └── direction_bias（新增）
  └── → 阶段三（脚本）

阶段三（脚本）
  ├── 解析 decision JSON
  ├── action = "archive"?（新增）← 改动 4
  │   ├── 调用 archive-cycle.js
  │   └── writeCooldown(72h) ← 改动 5
  ├── action = "wait" → skip
  ├── action = "open/add/reduce/..." → executeTrade
  └── → 同步持仓 → 归档判断 → output
```

---

## 不涉及的改动

以下**不做**：

- ❌ 不改 `tasks/pipeline/stage2-zhuang.md`
- ❌ 不改 `tasks/pipeline/stage1.md`
- ❌ 不改 `scripts/stage1-prep.js`、`stage4-executor.js`
- ❌ 不改 `scripts/scanner-runner.sh`（scanner-full.py 处理冷却）
- ❌ 不改 BTC 日报流程
- ❌ 不改 archive-cycle.js（由 stage3 直接处理冷却写入）

---

## 实施顺序

1. **先改 stage2-alt.md** — 规则先行，模型才知道新行为
2. **再改 stage3-executor.js** — 脚本能处理模型输出的新 action
3. **新建 coin-cooldown.json** — 数据结构就位
4. **改 scanner-full.py** — 最后，防复发

预计总改动量：约 200 行新增 + 20 行修改。
