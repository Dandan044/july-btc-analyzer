# P0 实施规划 v2（修正版）

> 只改 alt 流程 | 改动量最小化 | 2026-06-03

---

## 架构变更

```
原方案: 模型自检 → 模型自己决定归档 → stage3 执行归档
              ❌ 冗余、增加提示词复杂度

新方案: 
  模型侧: 只加约束规则（强制方向承诺 + 单向观察条件）
  系统侧: 独立的 PM2 进程静默监控 → 发现僵尸 → 直接杀死
              ✅ 模型不感知、分析不中断、逻辑完全解耦
```

---

## 改动清单

| # | 文件 | 类型 | 说明 |
|---|------|------|------|
| 1 | `profiles/analysis-alt.md` | 修改 | 四、开仓策略 → 加方向承诺规则 |
| 2 | `modules/04-交易决策JSON.md` | 修改 | 加 `direction_bias` 字段 + wait 必须继承方向 |
| 3 | `scripts/cycle-auto-archiver.js` | **新建** | PM2 进程，每 15 分钟扫描一次僵尸周期 |
| 4 | `data/coin-cooldown.json` | **新建** | 冷却名单 |
| 5 | `scripts/scanner-full.py` | 修改 | 窗口扫描阶段跳过冷却币种 |
| 6 | `ecosystem.config.js` | 修改 | 注册 cycle-auto-archiver 进程 |
| 7 | `scripts/archive-cycle.js` | 修改 | 加 `--no-review` 参数（可选优化） |

---

## 改动 1：analysis-alt.md — 方向承诺规则

**文件**：`tasks/pipeline/profiles/analysis-alt.md`
**位置**：「四、开仓策略」→「决策原则」段（约第 200 行）

### 修改前

```
**决策原则：**
- 三维共振且方向明确 → 顺势开仓
- 驱动力衰减 + 反转信号累积 → 可选择左侧反向布局
- 信号矛盾或模糊 → 观望，列出观察条件
- 已有持仓但驱动逻辑反转 → 给出平仓指令
- **BTC 4H 和 24H 同时逆风 + 币种与btc强相关 → 这单的条件可能没到，观望比开仓更合理**
```

### 修改后

```
**决策原则（按优先级）：**

| 优先级 | 条件 | 动作 |
|--------|------|------|
| 🟢 P1 | 三维共振且方向明确 | 顺势开仓（open） |
| 🟢 P1 | 驱动力衰减 + 反转信号累积 | 可选左侧反向开仓 |
| 🟡 P2 | 信号矛盾但方向可辨 | 观望 + 列出**单向**观察条件 |
| 🟡 P2 | 已有持仓但驱动逻辑反转 | 平仓 |
| 🟡 P2 | BTC 4H+24H 同时逆风 + 强相关 | 观望 |

### ⚠️ 方向承诺机制

**首周期：** 在第一份报告中，完成前置 A/B 后，你必须选定一个方向倾向（`direction_bias`），写入 trade-decision.json。选定后，本周期内所有 `observation_conditions` 只能朝此方向设置。

**方向选定规则：**

| 条件 | 如何选 |
|------|--------|
| 利多高置信度信号 ≥ 3 且 ≥ 利空高置信度 × 2 | `direction_bias: "bullish"` |
| 利空高置信度信号 ≥ 3 且 ≥ 利多高置信度 × 2 | `direction_bias: "bearish"` |
| 不满足上述两者 | **仍然必须选**。比较利多 vs 利空**总信号数**（不分置信度），多者 = 方向倾向。平局则倾向于逆散户方向（L/S 比 > 1.5 → bearish，< 0.67 → bullish） |

> 🚫 **铁律：禁止双向观察条件。** 选了 bullish → observation_conditions 只能列做多触发条件。选了 bearish → 只能列做空触发条件。不存在「等涨做多、等跌做空」的中间态——那是没有判断，不是分析。

**非首周期：** 方向倾向从上一份 trade-decision.json 继承。如果市场结构发生根本性逆转（不是微调），才能在报告中说明原因并切换方向。

**决策追溯格式（更新）：**

格式在原有基础上增加一行方向倾向：
- 方向倾向：bullish / bearish（必须填写）
```

---

## 改动 2：交易决策 JSON — 新增字段

**文件**：`tasks/pipeline/modules/04-交易决策JSON.md`
**位置**：字段说明表 + 字段选择规则

### 2.1 action 枚举增加说明

当前：
```
| `action` | string | `open` / `add` / `reduce` / `close` / `adjust` / `hold` / `wait` |
```

不变。action 枚举不增减（archive 由外部 PM2 处理，不经过模型）。

### 2.2 新增字段

在 `observation_conditions` 行之后插入：

```
| `direction_bias` | string | `bullish` / `bearish`。**必填**。首周期在方向承诺时写入，后续报告从上一份继承 |
```

### 2.3 修改字段选择规则

当前 wait 规则：
```
- `action = wait` → 无持仓等待条件，`observation_conditions` 必填
```

改为：
```
- `action = wait` → 无持仓等待条件，`observation_conditions` 必填，`direction_bias` 必填（首周期选定后继承）
- `action = wait` 且首周期 → `direction_bias` 必须基于前置 A 信号统计选定，observation_conditions 只能朝此方向设置
- `action = wait` 且非首周期 → `direction_bias` 从上一份 trade-decision 继承，不得无故变更方向
```

### 2.4 JSON 示例新增字段

在 JSON 结构的 `observation_conditions` 之前增加：

```json
  "direction_bias": "bullish",
```

---

## 改动 3：cycle-auto-archiver.js（新建 PM2 进程）

**文件**：`scripts/cycle-auto-archiver.js`（新建）

### 功能

每 15 分钟扫描 `active/` 下所有 `alt-*` 和 BTC 周期：

```
FOR each cycle directory:
  1. 读取周期目录名 → 解析创建时间戳
  2. IF 当前时间 - 创建时间 > 24h:
     3. 读取最新 trade-decision-*.json
     4. IF action == "wait" 且 当前持仓数 == 0:
        → 归档此周期
        → 归档其活跃警报规则
        → 写入 coin-cooldown.json (72h)
        → 不创建复盘任务
```

### 核心逻辑

```javascript
#!/usr/bin/env node
/**
 * cycle-auto-archiver.js
 * 每 15 分钟扫描一次，静默杀死超过 24h 仍无持仓的 wait 周期
 * PM2 常驻进程
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORKSPACE = path.join(__dirname, '..');
const ACTIVE_DIR = path.join(WORKSPACE, 'active');
const ARCHIVE_SCRIPT = path.join(__dirname, 'archive-cycle.js');
const COOLDOWN_PATH = path.join(WORKSPACE, 'data', 'coin-cooldown.json');
const LOG_FILE = path.join(WORKSPACE, 'logs', 'cycle-auto-archiver.log');

const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 分钟
const MAX_AGE_HOURS = 24;
const COOLDOWN_HOURS = 72;

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function parseCycleAge(dirName) {
  // alt-COIN-YYYYMMDD-HHMM or zhuang-COIN-YYYYMMDD-HHMM or cycle-YYYYMMDD-NNN
  const match = dirName.match(/(\d{8})-(\d{4})$/);
  if (!match) return null;
  const [, date, time] = match;
  const created = new Date(
    parseInt(date.slice(0,4)), parseInt(date.slice(4,6))-1, parseInt(date.slice(6,8)),
    parseInt(time.slice(0,2)), parseInt(time.slice(2,4))
  );
  return (Date.now() - created.getTime()) / (1000 * 60 * 60); // hours
}

function getLatestTradeDecision(cycleDir) {
  const reportsDir = path.join(ACTIVE_DIR, cycleDir, 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs.readdirSync(reportsDir)
    .filter(f => f.startsWith('trade-decision-'))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(reportsDir, files[0]), 'utf8'));
}

function hasPosition(cycleDir) {
  const posFile = path.join(ACTIVE_DIR, cycleDir, 'positions.json');
  if (!fs.existsSync(posFile)) return false;
  try {
    const d = JSON.parse(fs.readFileSync(posFile, 'utf8'));
    return (d['汇总']?.['当前持仓数'] || 0) > 0;
  } catch { return false; }
}

function writeCooldown(coin, reason) {
  let cd = { _schema: "自动冷却名单", entries: {}, updated: null };
  try {
    if (fs.existsSync(COOLDOWN_PATH)) cd = JSON.parse(fs.readFileSync(COOLDOWN_PATH, 'utf8'));
  } catch {}
  cd.entries[coin] = {
    cooldown_until: new Date(Date.now() + COOLDOWN_HOURS * 3600000).toISOString(),
    reason: reason,
    added_at: new Date().toISOString()
  };
  cd.updated = new Date().toISOString();
  fs.writeFileSync(COOLDOWN_PATH, JSON.stringify(cd, null, 2) + '\n');
}

function scan() {
  log('========== 扫描开始 ==========');
  const dirs = fs.readdirSync(ACTIVE_DIR).filter(d => {
    return fs.statSync(path.join(ACTIVE_DIR, d)).isDirectory();
  });

  let archived = 0;

  for (const dir of dirs) {
    const age = parseCycleAge(dir);
    if (age === null || age < MAX_AGE_HOURS) continue;
    if (hasPosition(dir)) continue;

    const decision = getLatestTradeDecision(dir);
    if (!decision) continue;
    if (decision.action !== 'wait') continue;

    // 三维条件成立 → 归档
    const coin = decision.coin;
    log(`🔍 僵尸周期: ${dir} | coin=${coin} | age=${age.toFixed(1)}h | action=wait | 持仓=0 → 归档`);

    try {
      // 1. 归档周期（含规则归档）
      execSync(
        `node "${ARCHIVE_SCRIPT}" --cycle ${dir} --by lifetime-expired --reason "24h超时无入场机会" --close-type "手动归档"`,
        { encoding: 'utf8', timeout: 30000, cwd: WORKSPACE }
      );
      log(`  📦 ARCHIVE: ${dir} → archived/`);
      
      // 2. 冷却
      writeCooldown(coin, `24h超时无入场机会 (cycle: ${dir})`);
      log(`  🧊 冷却: ${coin} → ${COOLDOWN_HOURS}h`);
      
      archived++;
    } catch (e) {
      log(`  ⛔ 归档失败: ${dir} → ${e.message}`);
    }
  }

  log(`========== 扫描结束 | 归档: ${archived} | 下次: ${SCAN_INTERVAL_MS/60000}min 后 ==========`);
}

// 启动
log('🚀 cycle-auto-archiver 启动 | 扫描间隔: 15min | 最大年龄: 24h | 冷却: 72h');
scan();
setInterval(scan, SCAN_INTERVAL_MS);
```

### 日志

输出到 `logs/cycle-auto-archiver.log`。

---

## 改动 4：coin-cooldown.json（新建）

**文件**：`data/coin-cooldown.json`（新建）

```json
{
  "_schema": "自动冷却名单。僵尸周期归档后自动写入，scanner 窗口扫描阶段跳过。由 cycle-auto-archiver.js 自动维护。",
  "entries": {},
  "updated": null
}
```

由 cycle-auto-archiver 的 `writeCooldown()` 函数自动维护。过期条目在 scanner 读取时惰性清除。

---

## 改动 5：scanner-full.py — 跳过冷却币种

**文件**：`scripts/scanner-full.py`
**位置**：`window_scan()` 函数，在现有黑名单检查之后

### 新增函数（文件顶部或 window_scan 前）

```python
import json, os
from datetime import datetime, timezone

COOLDOWN_PATH = os.path.join(WORKSPACE, "data", "coin-cooldown.json")

def load_cooldowns():
    """返回仍在冷却期内的币种集合"""
    try:
        with open(COOLDOWN_PATH, 'r') as f:
            data = json.load(f)
        entries = data.get('entries', {})
        now = datetime.now(timezone.utc)
        active = set()
        for coin, info in list(entries.items()):
            until = datetime.fromisoformat(info['cooldown_until'])
            if until > now:
                active.add(coin)
            else:
                del entries[coin]  # 惰性清除过期
        # 如果有过期被清除，写回
        if len(entries) != len(data.get('entries', {})):
            data['entries'] = entries
            data['updated'] = now.isoformat()
            with open(COOLDOWN_PATH, 'w') as f:
                json.dump(data, f, indent=2)
        return active
    except Exception:
        return set()
```

### window_scan 内

在黑名单检查后、活跃周期检查前插入：

```python
cooldowns = load_cooldowns()
for coin in list(candidates):
    if coin in cooldowns:
        candidates.remove(coin)
        stats["cooldown"] += 1
```

### stats 增加

```python
stats = {"blacklisted": 0, "cooldown": 0, "active_cycle": 0, "non_alt": 0, "oi_failed": 0}
```

---

## 改动 6：ecosystem.config.js

**文件**：`ecosystem.config.js`

在 apps 数组中增加（放在 `btc-alert` 之后）：

```javascript
{
    name: 'cycle-auto-archiver',
    script: './scripts/cycle-auto-archiver.js',
    cwd: __dirname,
    autorestart: true,
    watch: false,
    max_restarts: 5,
    restart_delay: 5000,
    max_memory_restart: '100M',
    error_file: './logs/cycle-auto-archiver.log',
    out_file: './logs/cycle-auto-archiver.log',
    merge_logs: true,
    time: true,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      http_proxy: '',
      https_proxy: '',
      NO_PROXY: '*'
    }
}
```

启动：`pm2 start ecosystem.config.js --only cycle-auto-archiver && pm2 save`

---

## 不涉及的改动

| 文件 | 原因 |
|------|------|
| `stage3-executor.js` | 归档走 PM2 外部进程，不经过 stage3 |
| `archive-cycle.js` | 现有接口已满足需求（`--by` `--reason` `--close-type`） |
| `stage2-zhuang.md` | P0 只改 alt |
| BTC 日报相关 | 不动 |

---

## 改动汇总

```
tasks/pipeline/profiles/analysis-alt.md   ← 方向承诺规则（~30 行新增）
tasks/pipeline/modules/04-交易决策JSON.md  ← direction_bias 字段（~10 行修改）
scripts/cycle-auto-archiver.js            ← 新建（~90 行）
data/coin-cooldown.json                   ← 新建（~5 行）
scripts/scanner-full.py                   ← 冷却跳过（~25 行新增）
ecosystem.config.js                       ← PM2 注册（~15 行新增）
```

总工作量约 175 行新增 + 10 行修改。轻重分明，改动面极小。
