# 周期健康检查任务

每日触发（建议凌晨 3:00 GMT+8），扫描所有活跃山寨币周期，诊断 + 自动处置静默问题。

---

## 核心原则

**能自动处理的自动处理，需要人工判断的明确报警。**

- 空壳周期 → 直接删除
- 无持仓静默周期 → 自动归档
- 有持仓静默周期 → 查实时状态后报警（不做自动平仓操作）

---

## 决策树

```
扫描 active/ 下所有周期
│
├─ BTC 周期 (cycle-*) → ⏭️ 跳过，不在检测范围内
│
└─ 山寨币周期 (alt-*)
   │
   ├─ 无报告 + 无数据文件 + 无活跃警报规则
   │   └─ 🗑️ 直接删除（记录日志）
   │
   ├─ 静默 < 24h → ⏭️ 跳过
   │
   └─ 静默 ≥ 24h
       │
       ├─ 无持仓
       │   └─ 📦 自动归档（记录日志）
       │
       └─ 有持仓
           │
           ├─ 无活跃警报规则
           │   └─ ⚠️ 明确报警：持仓无监控（高风险）
           │
           └─ 有活跃警报规则
               │
               ├─ 实时查 OKX 有 TP/SL 委单 → 🟢 无需操作
               └─ 实时查 OKX 无 TP/SL 委单 → ⚠️ 明确报警：裸仓运行（高风险）
```

---

## 关键定义

### ⚠️ positions.json 读取陷阱

**字段名是中文，不是英文！** 历史上健康检查任务曾因使用 `d.get('positions')` 导致所有周期误判为无持仓。

```python
# ❌ 错误：字段不存在，永远返回空
pos = d.get('positions', [])

# ✅ 正确：positions.json 使用中文键名
pos = d.get('当前持仓', [])
count = d.get('汇总', {}).get('当前持仓数', 0)
```

**推荐做法**：直接用 `汇总.当前持仓数` 判断，不遍历数组。

### 「有警报」的判定

**不仅看文件是否存在**，必须验证规则有效性：

```javascript
// 判断一条规则是否「活跃」
function isActiveRule(rule) {
  return rule.lifetime() === 'active';
}
```

- **有活跃警报** = 至少 1 条规则文件的 `lifetime()` 返回 `'active'`
- **无活跃警报** = 无规则文件，或所有规则 `lifetime()` 返回 `'expired'` / `'completed'`

### 「静默」的判定

最后报告时间距今 ≥ 24 小时，或 reports/ 目录下无任何报告文件。

### 「无数据文件」的判定

reports/ 为空 **且** data-context/ 为空。

---

## 执行步骤

### 步骤 0：准备工作

1. 确认当前时间
2. 确保 `cycle-health/` 目录存在
3. 初始化操作日志写入句柄（`cycle-health/actions.log`）

---

### 步骤 1：扫描活跃周期

列出 `active/` 下所有子目录（排除 `.gitkeep` 和嵌套的 `active/active/`）：

```bash
find active/ -maxdepth 1 -type d ! -name 'active' ! -name '.gitkeep' | sort
```

对每个周期目录，提取：
- **周期 ID**：目录名
- **类型**：`cycle-*` = BTC → 跳过；`alt-*` = 山寨币 → 继续
- **最后报告时间**：`reports/` 下最新文件的修改时间
- **报告数量**：`reports/` 下文件数量
- **是否有 positions.json**
- **数据文件数**：`data-context/` 下文件数
- **关联警报规则**：在 `skills/btc-alert/rules/` 中搜索

### 步骤 2：判定警报规则活跃状态

对每个山寨币周期，搜索关联警报规则并判定活跃状态：

```bash
ls skills/btc-alert/rules/{COIN}-*.js 2>/dev/null
```

对找到的每条规则，执行 `lifetime()` 检查：

```javascript
const rule = require('./skills/btc-alert/rules/{COIN}-xxx.js');
const state = rule.lifetime(); // 必须是 'active'
```

- 如果 `lifetime()` 返回 `'expired'` 或 `'completed'` → 该规则不算活跃
- 只有返回 `'active'` 的规则才计入「有活跃警报」

### 步骤 3：按决策树分类处置

对每个山寨币周期，按决策树判定：

#### 分支 A：空壳周期 — 直接删除

**条件**：无报告 + 无数据文件 + 无活跃警报规则

```
操作：rm -rf active/{周期ID}
日志：DELETE | {周期ID} | 空壳周期，无报告无数据无警报
```

#### 分支 B：无持仓静默周期 — 自动归档

**条件**：静默 ≥ 24h，positions.json 中无活跃持仓

```
操作：
  1. 清理该币种的警报规则 → node scripts/archive-rules.js --coin ${COIN} --by cycle-health-check --reason "周期静默${HOURS}h无持仓，健康检查自动归档"
  2. mv active/{周期ID} archived/{周期ID}
  3. 记录日志
日志：ARCHIVE | {周期ID} | 静默{X}h，无持仓 | 报告{N}篇
```

**归档前**：如果 positions.json 中记录了活跃持仓，但实盘已平仓，需同步平仓信息到 positions.json 再归档。见步骤 4。

#### 分支 C：有持仓 + 无活跃警报 — 报警

**条件**：静默 ≥ 24h，positions.json 中有活跃持仓，无活跃警报规则

```
操作：
  1. ⚠️ 明确报警（报告中标记 + 通知十四月）
  2. 不删除、不归档，保留周期等待人工处理
日志：WARN | {周期ID} | 持仓无监控{X}h，无活跃警报 | 持仓详情...
```

#### 分支 D：有持仓 + 有活跃警报 — 查 TP/SL

**条件**：静默 ≥ 24h，positions.json 中有活跃持仓，有活跃警报规则

```
操作：
  1. 实时查 OKX 该币种的委单状态（见步骤 5）
  2. 有 TP/SL 委单 → 🟢 无需操作
  3. 无 TP/SL 委单 → ⚠️ 报警：裸仓运行
日志：
  - 有TP/SL: INFO | {周期ID} | 持仓{X}h，有TP/SL保护 | 无需操作
  - 无TP/SL: WARN | {周期ID} | 裸仓运行{X}h，无TP/SL | 持仓详情...
```

#### 分支 E：静默 < 24h — 跳过

不操作，仅在报告中记录概览。

### 步骤 4：归档时同步实盘持仓状态

⚠️ **安全原则：宁可漏判，不可误判。API 异常时默认信任快照，不做覆写。**

在归档（分支 B）前，如果 `positions.json` 记录了活跃持仓，必须查 OKX 实盘确认。

#### 4.1 查询实盘持仓（带重试）

```bash
# 带重试的持仓查询（最多 3 次，每次间隔 2 秒）
COIN="{COIN}"
MAX_RETRIES=3
RETRY_DELAY=2

get_positions() {
  for i in $(seq 1 $MAX_RETRIES); do
    result=$(scripts/okx-proxy.sh --profile live account positions 2>/dev/null | python3 -c "
import sys,json
try:
    data = json.load(sys.stdin)
    items = data.get('data', data) if isinstance(data, dict) else data
    if not isinstance(items, list):
        sys.exit(1)
    for p in items:
        if '${COIN}' in p.get('instId', '') and float(p.get('pos', 0)) > 0:
            print(json.dumps({'found': True, 'posId': p.get('posId'), 'pos': p.get('pos'), 'avgPx': p.get('avgPx'), 'posSide': p.get('posSide'), 'upl': p.get('upl')}))
            sys.exit(0)
    print(json.dumps({'found': False}))
except:
    sys.exit(1)
" 2>/dev/null)
    
    if [ $? -eq 0 ] && [ -n "$result" ]; then
      echo "$result"
      return 0
    fi
    
    if [ $i -lt $MAX_RETRIES ]; then
      echo "[重试 $i/$MAX_RETRIES] OKX 持仓查询失败，${RETRY_DELAY}s 后重试..." >&2
      sleep $RETRY_DELAY
    fi
  done
  
  # 全部重试失败 → 返回 UNKNOWN
  echo '{"found": null, "error": "api_failure_after_retries"}'
  return 1
}

result=$(get_positions)
```

#### 4.2 按查询结果同步

| 查询结果 | 含义 | 操作 |
|----------|------|------|
| `found: true` | 实盘有该币种活跃持仓 | → **不应走分支 B**，转为分支 C/D 处理 |
| `found: false` | 实盘确认无该币种持仓 | → **可以归档**：更新 positions.json 标注已平仓，然后归档 |
| `found: null` (API 异常) | 无法确认实盘状态 | → **❌ 禁止覆写！** 跳过本次同步，保留 positions.json 不变，不归档。记录 WARN 日志。 |

#### 4.3 禁止操作清单

- ❌ API 异常/空响应时，**禁止**判定为「已平仓」
- ❌ API 异常时，**禁止**覆写 positions.json
- ❌ 不能仅凭「API 返回空数组」就认为无持仓——空数组可能是 429 限流、代理故障、网络超时等
- ✅ 只有 `found: false`（查询成功 + 确实无持仓）才可归档
- ✅ API 异常 → 保留快照 + 记录 WARN + 下轮继续检查

### 步骤 5：实时查 OKX TP/SL 委单

对有持仓且需判断 TP/SL 的周期，查实盘委单：

```bash
# 查询该币种的未成交委单
scripts/okx-proxy.sh --profile live account orders --instId {COIN}-USDT-SWAP
```

**判定**：存在 `ordType` 为 `oco`（OCO止盈止损）或 `move_order_stop`（移动止盈止损）的委单 → 有 TP/SL 保护。

### 步骤 6：生成健康检查报告

保存到 `cycle-health/YYYY-MM-DD-cycle-health.md`。

报告格式：

```markdown
# 周期健康检查报告 📋

**检查日期**: YYYY-MM-DD  
**检查时间**: HH:MM GMT+8  
**山寨币周期总数**: N  
**BTC 周期（已豁免）**: M

---

## 一、本次操作

| 操作 | 周期 ID | 原因 |
|------|---------|------|
| 🗑️ DELETE | ... | ... |
| 📦 ARCHIVE | ... | ... |
| ⚠️ WARN | ... | ... |

---

## 二、活跃周期概览

| 周期 ID | 币种 | 最后报告 | 静默时长 | 持仓 | 活跃警报 | 状态 |
|---------|------|---------|---------|------|---------|------|
| ... | ... | ... | ... | ... | ... | 🟢/🟡/🔴 |

## 三、报警详情

### ⚠️ 持仓无监控
（分支 C 和 D2 — 有持仓但无警报或无 TP/SL）

### 🟡 裸仓运行
（分支 D2 — 有持仓有警报但无 TP/SL 保护）

## 四、统计汇总

- 山寨币周期总数: N
- 已删除空壳: N
- 已归档: N
- 报警（需人工处理）: N
- 正常（< 24h 或有 TP/SL）: N

---

*由周期健康监控自动生成，{检查时间}。*
```

### 步骤 7：写入操作日志

所有操作写入 `cycle-health/actions.log`，格式：

```
YYYY-MM-DD HH:MM | {操作} | {周期ID} | {原因} | {详情}
```

示例：
```
2026-05-13 03:00 | DELETE | alt-BEAT-20260512-1521 | 空壳周期，无报告无数据无警报 | -
2026-05-13 03:00 | ARCHIVE | alt-ATH-20260511-1836 | 静默28h，无持仓 | 报告1篇
2026-05-13 03:00 | WARN | alt-SPK-20260511-1036 | 持仓无监控29h，有活跃警报+TP/SL | SHORT 9张@0.03331, TP/SL已设
2026-05-13 03:00 | WARN | alt-STRK-20260511-1218 | 持仓无监控34h，有活跃警报+TP/SL | SHORT 591张@0.05078, TP/SL已设
```

### 步骤 8：通知十四月（仅当有报警）

如果存在任何 WARN 级别的周期：

```
sessions_send:
  sessionKey: "agent:shisiyue:main"  
  message: |
    ⚠️ 周期健康检查报警：

    {逐条列出报警周期及持仓详情}

    详情已保存到 cycle-health/YYYY-MM-DD-cycle-health.md
```

无报警则不需要通知。

---

## 安全约束

| 约束 | 说明 |
|------|------|
| 🚫 不做平仓 | 任何情况下不自动平仓或修改持仓 |
| 🚫 不做修改 | 不修改活跃周期内的任何文件（归档时的持仓同步除外） |
| 🚫 不覆写持仓快照 | positions.json 仅在归档（分支 B）且实盘确认无持仓时更新。API 异常 → 不覆写。静默 < 24h 的周期 → 不碰 positions.json。 |
| ✅ 只做清理 | 删除空壳、归档已完成周期 |
| ✅ 报警优先 | 有任何不确定 → 报警而非自动处理 |
| 📌 参考案例 | 2026-05-23 INJ：健康检查误将 API 瞬时异常判为「已平仓」，错误覆写 positions.json。教训：API 不可靠，快照是真理，宁可漏判不可误判。 |

---

## 技术参考

### 目录结构
```
active/
├── cycle-YYYYMMDD-XXX/          # BTC 周期（豁免）
└── alt-{COIN}-YYYYMMDD-HHMM/    # 山寨币周期
    ├── reports/                  # 报告文件
    ├── positions.json            # 实盘持仓快照
    └── data-context/             # 数据上下文
archived/                         # 归档目录
cycle-health/                     # 健康检查输出
├── actions.log                   # 操作日志
└── YYYY-MM-DD-cycle-health.md    # 诊断报告
```

### 警报规则目录
```
skills/btc-alert/rules/           # 活跃规则
skills/btc-alert/rules-archive/   # 已归档规则
```

### 实盘查询命令
```bash
# 查询持仓
scripts/okx-proxy.sh --profile live account positions

# 查询委单（含 TP/SL）
scripts/okx-proxy.sh --profile live account orders --instId {COIN}-USDT-SWAP

# 查询币种行情
curl -s --max-time 10 --proxy "http://127.0.0.1:7890" \
  "https://www.okx.com/api/v5/market/ticker?instId={COIN}-USDT-SWAP"
```

### 数据获取原则
- 串行获取，每请求间隔 ≥ 1 秒，避免触发 OKX 429 限流
- 只对需处置的周期获取实盘数据，非静默周期仅记录概览

---

📈 七月 — 周期健康监控任务 v2 (诊断 + 自动处置)
