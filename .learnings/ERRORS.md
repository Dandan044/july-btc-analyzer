# 错误记录

## 2026-05-01: 警报规则 lifetime() 返回值类型错误 — 导致无限重载循环

**问题：** 警报引擎对「延迟确认多价位监控」规则陷入无限加载-卸载循环，每~57秒重新加载一次，累计566次，日志膨胀至3MB。

**根因：** 规则 `lifetime()` 返回布尔值 (`true`/`false`)，而引擎 `engine.js` 的 `runRule()` 期望返回字符串：
```js
// engine.js runRule()
const status = lifetime();
if (status === 'expired' || status === 'completed') { ... return 'stop'; }
if (status !== 'active') { ... return 'stop'; }  // ← true/false 不等于 'active'！
```

当 `lifetime()` 返回 `true` 时，`true !== 'active'` → 引擎标记为 `RULE_STOPPED` → `unloadRule` 从 `activeRules` 移除。60秒文件扫描器发现 `.js` 文件仍在 `rules/` 目录 → 识别为「新规则」→ `startRuleTimer()` → `runRule()` → 又是 `true !== 'active'` → 循环。

**错误写法：**
```js
lifetime() {
  const created = new Date(CREATED_DATE);
  const now = new Date();
  const ageHours = (now - created) / (60 * 60 * 1000);
  return ageHours < 72;  // ❌ 返回 boolean
}
```

**正确写法：**
```js
lifetime() {
  const created = new Date(CREATED_DATE);
  const now = new Date();
  const ageHours = (now - created) / (60 * 60 * 1000);
  return ageHours < 72 ? 'active' : 'expired';  // ✅ 返回字符串
}
```

**引擎 API 合约（engine.js）：**
| 方法 | 返回类型 | 说明 |
|------|---------|------|
| `check()` | `boolean` \| `Promise<boolean>` | 触发条件是否满足 |
| `collect()` | `object` | 收集触发数据 |
| `trigger(alert)` | `void` | 触发动作 |
| `lifetime()` | `'active'` \| `'expired'` \| `'completed'` | ⚠️ 必须是字符串！ |

**影响范围：** rules-archive/ 中 17 个归档规则也存在相同写法，但不影响运行（引擎只加载 rules/ 目录）。修复后需确保未来所有规则严格使用字符串返回值。

**修复状态：** ✅ 已修复 `2026-04-30-price-multi-levels-v11.js`

---

## 2026-03-27: 止盈判断错误

**问题：** 在 cycle-20260327-001 的即时分析中，错误判断止盈2 ($65,000) 已触发，实际上价格最低只到 $65,716.95，距离止盈目标还有 $717。

**原因：**
1. 警报触发价是 $65,750（30日低点支撑），我混淆了"支撑跌破"和"止盈触发"
2. 看到价格跌破 $65,750 时，错误地认为已经触及 $65,000 止盈
3. 没有严格对照止盈价格进行判断

**正确做法：**
1. 止盈触发判断必须严格对照 `trade-suggestions.json` 中设置的价格
2. 止盈是止盈，支撑跌破是支撑跌破，两者不能混淆
3. 在归档前，应该明确验证：`最低价 <= 止盈价格` 才算触发

**影响：**
- 周期被提前归档
- 如果用户按 $65,000 止盈执行，实际可能还在持仓
- 收益率计算可能有误

**修复建议：**
- 未来在即时报告中，明确列出"最低价"和"止盈价格"对比
- 如果最低价未触及止盈，不要标记为"已触发"

---

## 2026-04-13: 多空比警报API选择错误

**问题：** 创建多空比警报时，错误使用了Binance API endpoint，导致警报无法工作。

**错误尝试：**
1. 第一次尝试：`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=15m&limit=1`
   - 结果：地区限制错误 "Service unavailable from a restricted location"
2. 第二次尝试：OKX endpoint路径错误
   - 结果：404 Not Found

**正确做法：**
使用OKX API endpoint（已验证可用）：
```
https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D
```

**数据格式：**
```json
{"code":"0","data":[["timestamp","ratio"],...]}
// data[0][1] 是最新多空比
```

**如何找到正确endpoint：**
1. 查看现有工作脚本：`skills/btc-market-lite/scripts/get_enhanced_analysis.js`
2. 搜索关键词：`long-short-account-ratio`
3. 找到已验证的endpoint和参数格式

**教训：**
- **不要猜测API endpoint**，先查看现有代码中是否已使用
- 日报脚本已成功获取多空比数据，说明正确endpoint一定存在
- 国内网络访问Binance API受限，优先使用OKX API

**修复：**
已重新创建警报使用正确的OKX API endpoint，警报正常运行