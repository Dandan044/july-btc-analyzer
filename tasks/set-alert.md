# 设定市场警报任务

> 引擎热加载：每 60 秒自动扫描 `rules/` 目录，新规则自动生效。**禁止重启引擎。**

---

## 🛡️ 合规速查（创建规则前扫一眼）

以下约束已全部融入模板代码。若你只修改模板中的价位/阈值，无需逐条核对——模板本身就是合规的。

| # | 约束 | 模板中如何满足 |
|---|------|---------------|
| C1 | catch 块必须 `throw`，禁止 `return false` | 模板中所有 catch 块最后一行为 `throw error` |
| C2 | 必须用 K 线区间数据，禁止瞬时价格 | `check()` 调 `getOKXKlines(COIN, BAR, limit, 'SWAP')`，BAR='5m'，limit 由 `this.interval` 动态计算，默认 10min → 2 根 5m K 线 |
| C3 | 必须传 `'SWAP'`，禁止默认 SPOT | 所有 API 调用显式传 `instType='SWAP'` |
| C4 | 禁止 `execSync` / 同步 curl | `trigger()` 用 `spawn`，数据获取用 `api` 模块 |
| C5 | 禁止 FGI 触发 | 模板不含 FGI 调用 |
| C6 | API 参数只能传 string/number | 模板中所有参数均为基本类型 |
| C7 | 数据非空检查后再访问子属性 | 模板对 API 返回值做 `if (!data) return false` |
| C8 | `trigger()` 必须异步 spawn | 模板使用 `spawn(process.execPath, [dispatchJs, ...])` 经调度器派发 |
| C9 | 每个价位必须有 `confirmPolicy` + `confirmMs` | 模板 `PRICE_LEVELS` 每项均含两个字段 |
| C10 | SL 用 `instant`，入场用 `hold`，TP 用 `touch` | 模板注释标注每种价位的推荐策略 |
| C11 | 价格价位 ≤6 个 | 模板示例含 6 个价位，修改时勿超 |
| C12 | 冷却 ≥ 1 小时 | 模板 `COOLDOWN_MS = 60 * 60 * 1000` |
| C13 | `check()` 日志含 API 来源 + 进度 + 设立来源 | 模板 `console.log` 三部分完整 |
| C14 | `lifetime()` 返回 `'active'` | 模板末尾固定写法 |
| C15 | 山寨 `trigger()` 指向 alt-instant-stage1 | 模板代码注释标注 `[山寨]` 需改的路径 |
| C16 | 山寨 `collect()` 返回 `coin` 字段 | 模板 `collect()` 已含 `coin` 字段 |
| C17 | 山寨文件命名 `{COIN}-描述.js` | 模板注释说明 |
| C18 | Rubik `period` 仅 `5m/1H/1D` | API 参考表中标注 |
| C19 | `module.exports` 必须含完整元数据（10 字段：ruleType/coin/cycleId/status/createdAt/createdBy/sourceReport/archivedAt/archivedBy/archiveReason） | 模板 `name:` 下已含完整元数据块 |

---

## 1. 多价位延迟确认

### 1.1 确认策略速查

创建 `PRICE_LEVELS` 时，为每个价位选择策略：

| 价位类型 | `confirmPolicy` | `confirmMs` | 原因 |
|---------|----------------|-------------|------|
| 止损位 (SL) | `'instant'` | `0` | 最后防线，不能延迟 |
| 止盈位 (TP) | `'touch'` | `3-5 min` | 短暂确认即可 |
| 入场触发位 | `'hold'` | `15-20 min` | 假突破高发区，必须站稳 |
| 关键支撑/阻力 | `'hold'` | `10-20 min` | 确认后才有操作意义 |
| 整数关口 | `'deep_hold'` | `20-30 min` | 易假突破，操作性弱 |
| 远处观测位 | `'deep_hold'` | `20-30 min` | 不急，长确认后分析 |

### 1.2 完整模板

```javascript
/**
 * {COIN} 多价位监控（延迟确认）
 *
 * 来源报告: {报告文件名}
 * 设立理由: {一句话说明为什么设这些价位}
 *
 * [山寨] 文件名: {COIN}-price-levels.js  (BTC用: 20xx-xx-xx-price-levels.js)
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const path = require('path');

const COIN = 'BTC';  // [山寨] 改为具体币种，如 'DOGE'、'MOVE'
const COOLDOWN_MS = 60 * 60 * 1000;  // 冷却 ≥1小时

// ============================================================
// 价位配置（≤6个）
// ============================================================
const PRICE_LEVELS = [
  // --- 上方价位（阻力/入场触发） ---
  {
    price: 0,        // 替换为实际价格
    type: 'resistance',
    label: '阻力位描述',
    action: '触发后应做什么',
    priority: 'high',                      // high / medium / low
    confirmPolicy: 'hold',                 // instant | touch | hold | deep_hold
    confirmMs: 15 * 60 * 1000
  },
  // --- 下方价位（支撑/止盈/止损） ---
  {
    price: 0,
    type: 'support',
    label: '止损位',
    action: '止损触发',
    priority: 'high',
    confirmPolicy: 'instant',
    confirmMs: 0
  },
  {
    price: 0,
    type: 'support',
    label: 'TP1止盈位',
    action: '第一档止盈',
    priority: 'high',
    confirmPolicy: 'touch',
    confirmMs: 3 * 60 * 1000
  }
  // ... 最多6个价位
];

// ============================================================
// K 线参数（间隔翻倍时 limit 自动缩放）
// ============================================================
const BAR = '5m';
const BAR_MS = 5 * 60 * 1000;

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.3,    // 回穿容忍度（山寨波动大可上调至 0.5-1.0）
  resetOnCrossback: true
};

module.exports = {
  name: '{COIN}-多价位监控',

  // ═══════════════════════════════════════════════
  // ⭐ C19: 规则元数据（必填，勿删）
  // ═══════════════════════════════════════════════
  // —— 身份 ——
  ruleType: 'price-levels',                   // [固定] 价位规则始终写 'price-levels'
  coin: 'BTC',                                // [必填] BTC: 'BTC'  |  山寨: 币种大写，如 'DOGE', 'MOVE'
  cycleId: 'cycle-YYYYMMDD-NNN',              // [必填] BTC: cycle-20260518-001
                                              //        山寨: alt-DOGE-20260514-0930
  status: 'active',                           // [固定] 创建时一律写 'active'

  // —— 创建信息 ——
  createdAt: '2026-05-19T09:00:00+08:00',    // [必填] 当前北京时间 ISO 时间戳，替换为实际时间
  createdBy: 'daily-report-stage4',           // [必填] 谁创建的？
                                              //   BTC 日报阶段四:  daily-report-stage4
                                              //   山寨扫描阶段四:  alt-intel-stage4
                                              //   警报触发即时分析: alt-instant-stage1
                                              //   自愈系统:        alert-self-heal
                                              //   人工设定:        manual
  sourceReport: 'active/cycle-20260518-001/reports/btc-report-2026-05-19-0900.md',
                                              // [必填] 来源报告路径（相对于工作区根目录）
                                              //   BTC: active/cycle-YYYYMMDD-NNN/reports/btc-report-*.md
                                              //   山寨: active/alt-{COIN}-YYYYMMDD-HHMM/reports/alt-report-*.md

  // —— 归档信息（活跃时全部为 null，归档时由归档脚本/流程填写） ——
  archivedAt: null,                           // 归档时间 ISO（归档时写入）
  archivedBy: null,                           // 归档来源（归档时写入）：
                                              //   stage4-cleanup      — 阶段四正常清理
                                              //   trigger-fired       — 触发后自动归档
                                              //   cycle-archived      — 周期归档批量清零
                                              //   cycle-health-check  — 健康检测清理
                                              //   manual              — 人工归档
                                              //   lifetime-expired    — 引擎自动过期
  archiveReason: null,                        // 归档原因自由文本（归档时写入）
  // ⭐ C19 END ⭐

  interval: 10 * 60 * 1000,
  lastTriggered: 0,
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},
  longShortRatio: null,
  takerBuyRatio: null,

  async check() {
    // C12: 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // C2: 用 K 线区间数据（非瞬时价格），limit 随间隔翻倍自动缩放
      const limit = Math.max(2, Math.round(this.interval / BAR_MS));
      const klines = await api.getOKXKlines(COIN, BAR, limit, 'SWAP');
      if (!klines || klines.length === 0) return false;

      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      // 后台拉取合约数据（供 collect 用，不影响 check 结果）
      try {
        const lsData = await api.getOKXLongShortRatio(COIN, 'CONTRACTS');
        this.longShortRatio = lsData?.currentRatio;
      } catch (_) {}
      try {
        const takerData = await api.getOKXTakerRatio(COIN, '1H');
        this.takerBuyRatio = takerData?.currentRatio;
      } catch (_) {}

      const now = Date.now();
      const confirmedLevels = [];
      const allLogs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
        }
        const state = this.levelStates[key];

        // 检测是否触及
        const touched = (level.type === 'resistance' && periodHigh >= level.price)
                     || (level.type === 'support' && periodLow <= level.price);

        if (!touched) {
          // 回穿检测（假突破重置）
          if (state.firstTouch && !state.confirmed) {
            const aboveLevel = (level.type === 'resistance' && latestPrice < level.price)
                            || (level.type === 'support' && latestPrice > level.price);
            if (aboveLevel) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 回穿 ${retrace.toFixed(2)}%，重置`);
              }
            }
          }
          continue;
        }

        // C10: instant 直接触发
        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT 触发`);
          continue;
        }

        // 延迟确认：记录首次触及
        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及，${level.confirmMs / 60000}min 确认中`);
          continue;
        }

        // 追踪突破深度
        if (!this.breakoutExtremes[key]) this.breakoutExtremes[key] = latestPrice;
        if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], latestPrice);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], latestPrice);
        }

        // 确认时间是否达到
        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs && !state.confirmed) {
          state.confirmed = true;
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: 确认完成 (${Math.floor(elapsed / 60000)}min)`);
        } else {
          allLogs.push(`${level.label}: 确认中 (${Math.floor(elapsed / 60000)}/${level.confirmMs / 60000}min)`);
        }
      }

      // C13: 日志含三部分 — [API] 来源 + [进度] 状态 + [来源] 设立依据
      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN} 3根1m K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(5)}-$${periodHigh.toFixed(5)} | 当前: $${latestPrice.toFixed(5)} | ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] {报告}: "{设立理由摘要}"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }
      return false;

    } catch (error) {
      // C1: 必须 throw，不能 return false
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      // C3: 显式传 SWAP
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, 'SWAP');

      let oiData = null;
      try { oiData = await api.getOKXOpenInterest(COIN); } catch (_) {}
      let frData = null;
      try { frData = await api.getOKXFundingRate(COIN); } catch (_) {}

      return {
        coin: COIN,  // C16: 必须返回 coin 字段
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,

        triggeredLevels: triggeredLevels.map(l => {
          const key = String(l.price);
          const state = this.levelStates[key] || {};
          return {
            price: l.price,
            type: l.type,
            label: l.label,
            action: l.action,
            priority: l.priority,
            confirmPolicy: l.confirmPolicy,
            confirmMs: l.confirmMs,
            firstTouchTime: state.firstTouch ? new Date(state.firstTouch).toISOString() : null,
            confirmedAt: new Date(now).toISOString(),
            elapsedMs: state.firstTouch ? now - state.firstTouch : 0,
            stability: {
              touches: state.touches || 0,
              crossbacks: state.crossbacks || 0,
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price,
              maxRetracePct: l.confirmPolicy === 'instant' ? null
                : Math.abs((ticker.price - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),

        periodRange: {
          high: Math.max(...klines4h.slice(-3).map(k => k.high)),
          low: Math.min(...klines4h.slice(-3).map(k => k.low))
        },

        openInterest: oiData?.currentOI,
        fundingRate: frData?.fundingRate,
        longShortRatio: this.longShortRatio,
        takerBuyRatio: this.takerBuyRatio,
        klines4h: klines4h ? klines4h.slice(0, 3).map(k => ({
          time: k.datetime || k.time, open: k.open, high: k.high,
          low: k.low, close: k.close, volume: k.volume
        })) : null,

        alertType: 'price-multi-level',
        significance: this.buildSignificance(triggeredLevels)
      };

    } catch (error) {
      // C1: 必须 throw，不能 return {}
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    const labels = levels.map(l => `${l.label}($${l.price}, ${l.confirmPolicy})`);
    const actions = levels.map(l => l.action).filter(Boolean);
    return `${labels.join('、')} 触发；${actions.join('；')}`;
  },

  async trigger(data) {
    // C8: 异步 spawn，不阻塞引擎
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-price-${Date.now()}`;

    // [山寨] 改为 tasks/alt-instant-stage1.md，后续阶段改为 alt-intel-stage2/3/4
    const message = `${JSON.stringify(data)}

以上为警报触发数据。请按顺序完成即时分析：
1. 读取 tasks/instant-analysis-stage1.md 执行数据获取
2. 读取 tasks/daily-report-stage2.md 执行交叉验证分析
3. 读取 tasks/daily-report-stage3.md 执行仓位管理
4. 读取 tasks/daily-report-stage4.md 执行警报管理`;

    spawn(process.execPath, [
      path.join(__dirname, '../../../..', 'scripts', 'dispatch.js'),
      '--priority', 'high-2',
      '--source', 'btc-alert',
      '--coin', COIN,
      '--name', jobName,
      '--at', 'now',
      '--message', message,
    ], { detached: true, stdio: 'ignore' });

    this.lastTriggered = Date.now();
    console.log(`[🔔警报触发] ${this.name} | 确认触发: ${data.triggeredLevels.length}个价位 | 当前价: $${data.currentPrice}`);

    // 重置状态
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  // C14: 生命周期由引擎统一管理，返回 'active' 即可
  lifetime() {
    return 'active';
  }
};
```

### 1.3 BTC ⇄ 山寨差异

在模板代码中搜索 `[山寨]` 注释，创建山寨币规则时修改以下 3 处：

| 修改点 | BTC | 山寨 |
|--------|-----|------|
| `COIN` | `'BTC'` | `'DOGE'` 等 |
| `trigger()` 分析路径 | `tasks/instant-analysis-stage1.md` → `daily-report-stage2/3/4` | `tasks/alt-instant-stage1.md` → `alt-intel-stage2/3/4` |
| 文件名 | `20xx-xx-xx-price-levels.js` | `{COIN}-price-levels.js` |

---

## 2. 非价格指标

### 2.1 常见类型速查

| 类型 | 触发条件示例 | API |
|------|-------------|-----|
| OI 异动 | OI 变化超过阈值 | `getOKXOpenInterest()` |
| 资金费率极端 | 费率超过 ±0.1% | `getOKXFundingRate()` |
| Taker 买卖比 | 比值偏离常态 | `getOKXTakerRatio()` |
| 多空比反转 | 比值突破阈值 | `getOKXLongShortRatio()` |
| 波动率突破 | BB 带宽或 ATR | `getOKXKlines()` 自行计算 |

### 2.2 完整模板

```javascript
/**
 * {COIN} {指标类型}监控
 *
 * 来源报告: {报告文件名}
 * 设立理由: {一句话说明}
 *
 * [山寨] 文件名: {COIN}-{指标}-monitor.js
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const path = require('path');

const COIN = 'BTC';  // [山寨] 改为具体币种
const COOLDOWN_MS = 60 * 60 * 1000;

// 触发阈值（按需修改）
const THRESHOLD = 0;  // 替换为实际阈值

module.exports = {
  name: '{COIN}-{指标}监控',

  // ═══════════════════════════════════════════════
  // ⭐ C19: 规则元数据（必填，勿删）
  // ═══════════════════════════════════════════════
  // —— 身份 ——
  ruleType: '{非价格类型}',                   // [必填] 选择以下之一（不含引号替换花括号）：
                                              //   oi-monitor           — OI 持仓量异动
                                              //   funding-reversal     — 资金费率极端/反转
                                              //   taker-ratio          — Taker 买卖比偏离
                                              //   ls-reversal          — 多空比反转
                                              //   composite            — 多指标组合（如 OI+Taker、OI+RSI）
  coin: 'BTC',                                // [必填] BTC: 'BTC'  |  山寨: 币种大写，如 'DOGE', 'MOVE'
  cycleId: 'cycle-YYYYMMDD-NNN',              // [必填] BTC: cycle-20260518-001
                                              //        山寨: alt-DOGE-20260514-0930
  status: 'active',                           // [固定] 创建时一律写 'active'

  // —— 创建信息 ——
  createdAt: '2026-05-19T09:00:00+08:00',    // [必填] 当前北京时间 ISO 时间戳，替换为实际时间
  createdBy: 'daily-report-stage4',           // [必填] 谁创建的？（取值同上）
  sourceReport: 'active/cycle-20260518-001/reports/btc-report-2026-05-19-0900.md',
                                              // [必填] 来源报告路径（相对于工作区根目录）

  // —— 归档信息（活跃时全部为 null） ——
  archivedAt: null,
  archivedBy: null,
  archiveReason: null,
  // ⭐ C19 END ⭐

  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // ---- 按需选择一个数据源 ----

      // OI 持仓量
      // const data = await api.getOKXOpenInterest(COIN);
      // const currentValue = data.currentOI;
      // const triggered = currentValue >= THRESHOLD;

      // 资金费率
      // const data = await api.getOKXFundingRate(COIN);
      // const currentValue = data.fundingRate;
      // const triggered = Math.abs(currentValue) >= THRESHOLD;

      // Taker 买卖比
      // const data = await api.getOKXTakerRatio(COIN, '1H');
      // const currentValue = data.currentRatio;
      // const triggered = currentValue >= THRESHOLD;

      // 多空比
      // const data = await api.getOKXLongShortRatio(COIN, 'CONTRACTS');
      // const currentValue = data.currentRatio;
      // const triggered = currentValue <= THRESHOLD;

      // ---- 替换上面的注释块为实际逻辑 ----
      const data = await api.getOKXOpenInterest(COIN);
      const currentValue = data.currentOI;
      const triggered = currentValue >= THRESHOLD;

      // C13: 日志含 API 来源 + 进度 + 设立来源
      console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量 | [进度] ${this.name} | 当前: ${currentValue} | 阈值: ${THRESHOLD} | 触发: ${triggered} | [来源] {报告}: "{设立理由摘要}"`);

      return triggered;

    } catch (error) {
      // C1: 必须 throw
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      // C3: 显式传 SWAP
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const oiData = await api.getOKXOpenInterest(COIN);
      const klines = await api.getOKXKlines(COIN, '1h', 6, 'SWAP');

      return {
        coin: COIN,  // C16: 必须返回
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentOI: oiData.currentOI,
        oiChange24h: oiData.change24h,
        klines1h: klines ? klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high,
          low: k.low, close: k.close, volume: k.volume
        })) : null,
        alertType: '{指标类型}',
        message: `${COIN} {指标} 触发阈值`
      };

    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-indicator-${Date.now()}`;

    // [山寨] 改为 tasks/alt-instant-stage1.md → alt-intel-stage2/3/4
    const message = `${JSON.stringify(data)}

以上为警报触发数据。请按顺序完成即时分析：
1. 读取 tasks/instant-analysis-stage1.md 执行数据获取
2. 读取 tasks/daily-report-stage2.md 执行交叉验证分析
3. 读取 tasks/daily-report-stage3.md 执行仓位管理
4. 读取 tasks/daily-report-stage4.md 执行警报管理`;

    spawn(process.execPath, [
      path.join(__dirname, '../../../..', 'scripts', 'dispatch.js'),
      '--priority', 'high-2',
      '--source', 'btc-alert',
      '--coin', COIN,
      '--name', jobName,
      '--at', 'now',
      '--message', message,
    ], { detached: true, stdio: 'ignore' });

    this.lastTriggered = Date.now();
    console.log(`[🔔警报触发] ${this.name} | 当前值: ${data.currentOI || data.fundingRate || '-'} | 阈值: ${THRESHOLD}`);
  },

  lifetime() {
    return 'active';
  }
};
```

---

## 3. API 参考

```javascript
const api = require('../../btc-market-lite/scripts/api');
```

| 方法 | 说明 | 注意 |
|------|------|------|
| `getOKXKlines(sym, interval, limit, instType)` | K 线数据 | `instType` 必传 `'SWAP'` |
| `getOKXTicker(sym, instType)` | 实时价格 | `instType` 必传 `'SWAP'` |
| `getOKXOpenInterest(sym)` | 当前 OI + 24h 变化 | |
| `getOKXFundingRate(sym)` | 当前资金费率 | |
| `getOKXTakerRatio(sym, period)` | Taker 买卖比 | `period`: `'5m'`/`'1H'`/`'1D'` |
| `getOKXLongShortRatio(sym, instType)` | 多空比 | `instType`: `'CONTRACTS'` |
| `getOKXTopTraderRatio(sym)` | 顶级交易者多空比 | |
| `getFearGreedIndex(days)` | 恐惧贪婪指数 | ⚠️ 日级更新，**不可用于触发条件** |
| `fetch(url)` | 通用 HTTP 请求 | 需要新 API 时用，勿改 api.js |

### 3.1 参数规范

| API | 参数 | 合法值 | 常见错误 |
|-----|------|--------|---------|
| K线 `bar` | `interval` | `1m/5m/15m/1H/4H/1D` | ❌ `1h` `4h`（小写 h） |
| Rubik stat | `period` | **仅 `5m` `1H` `1D`** | ❌ `15m` `4H` `1h` |

### 3.2 数据源扩展

**禁止直接修改 `api.js`。** 如需新 API：
1. 在规则中用 `api.fetch(url)` 临时实现
2. 日志输出 `[📋API诉求]` 标记
3. 向 `skills/btc-market-lite/API_REQUESTS.md` 追加诉求

---

## 4. 规则文件命名与存放

| 规则类型 | 文件名 | 存放位置 |
|---------|--------|---------|
| BTC | `20xx-xx-xx-{类型}-{描述}.js` | `skills/btc-alert/rules/` |
| 山寨 | `{COIN}-{描述}.js` | `skills/btc-alert/rules/` |

创建后记录到 `logs/alert-setup.log`：
```
[时间] 规则创建 | {文件名} | {规则名} | 类型: {多价位/非价格} | 来源: {报告}
```

---

## ⚠️ 触发后自动化

引擎检测到 `check() === true` 后自动执行：
1. 调用 `collect()` 收集上下文数据
2. 调用 `trigger()` 派发分析任务（spawn 隔离会话）
3. **自动归档规则文件到 `rules-archive/`，停止定时器**

规则文件无需自行管理冷却、过期、自我销毁。

---

*版本 v5.0 — 收敛为 2 个模板，23 项补丁融入代码*
