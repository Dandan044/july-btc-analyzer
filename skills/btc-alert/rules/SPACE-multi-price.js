/**
 * SPACE 多价位延迟确认监控警报 v3
 * 更新于 2026-05-09 即时分析后
 *
 * 来源：alt-report-SPACE-2026-05-09-0411 (即时分析)
 * 报告观点：$0.0085突破确认但OI价背离持续扩大，观望。
 * 更新做多条件：$0.009 + 日成交量$15M + OI>2.8M
 * 更新做空条件：跌破$0.008
 *
 * v2→v3变更：移除已触发的$0.0085位，新增$0.009做多入场位和$0.008做空位
 */

const api = require('../../btc-market-lite/scripts/api');
const CONFIG = require('../../../tasks/global-config.json');
const { spawn } = require('child_process');

const COIN = 'SPACE';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;

// ============================================================
// ⭐ 多价位配置（4个价位 ≤6 上限）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 0.0090, type: 'resistance', label: '4H 38.2%斐波那契+做多入场位',
    action: '开多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  // 下方价位
  { price: 0.0080, type: 'support', label: '结构破坏确认+做空入场位',
    action: '开空入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.0076, type: 'support', label: '深度回调支撑观察位',
    action: null, priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 30 * 60 * 1000 },

  { price: 0.0070, type: 'support', label: '4H跌破确认位',
    action: '开空入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 }
];

// ============================================================
// ⭐ 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.2,     // SPACE波动大，允许0.2%回穿
  resetOnCrossback: true
};

module.exports = {
  name: 'SPACE多价位监控警报v3',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: [],

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // ⭐ 获取K线片段（覆盖3分钟检查间隔）
      const klines = await api.getKlines(COIN, '1m', 3);
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      const now = Date.now();
      const confirmedLevels = [];
      const allLogs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
        }
        const state = this.levelStates[key];

        const wasTouched = (level.type === 'resistance' && periodHigh >= level.price) ||
                          (level.type === 'support' && periodLow <= level.price);

        if (!wasTouched) {
          if (state.firstTouch && !state.confirmed) {
            const isAboveLevel = (level.type === 'resistance' && latestPrice < level.price) ||
                                 (level.type === 'support' && latestPrice > level.price);
            if (isAboveLevel) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 假突破(回穿${retrace.toFixed(3)}%)，重置`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT触发`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 触及$${level.price}，开始${level.confirmMs/60000}分钟确认`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
        }
        if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], latestPrice);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], latestPrice);
        }

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs && !state.confirmed) {
          state.confirmed = true;
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: ✅ 确认完成(${Math.floor(elapsed/60000)}分钟)`);
        } else if (!state.confirmed) {
          allLogs.push(`${level.label}: 确认中(${Math.floor(elapsed/60000)}/${level.confirmMs/60000}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] CC获取${COIN}3根1mK线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-09 SPACE即时分析v3: "观望，做多需$0.009+量能+OI回升，做空需$0.008跌破"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[❌${COIN}警报检查错误]`, error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      const ticker = await api.getTicker(COIN);
      const klines15m = await api.getKlines(COIN, '15m', 8);
      const klines1h = await api.getKlines(COIN, '1h', 4);

      // 获取OKX数据
      let oiData = null, takerData = null, lsRatio = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
        takerData = await api.getOKXTakerRatio(COIN);
        lsRatio = await api.getOKXLongShortRatio(COIN);
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange24h: ticker.change24h,

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
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price
            }
          };
        }),

        periodRange: {
          high: Math.max(...klines15m.slice(-3).map(k => k.high)),
          low: Math.min(...klines15m.slice(-3).map(k => k.low))
        },

        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        longShortRatio: lsRatio?.currentRatio,
        klines15m: klines15m.map(k => ({ time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
        klines1h: klines1h.map(k => ({ time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close })),

        alertType: 'SPACE多价位触发',
        significance: triggeredLevels.length === 1
          ? `${triggeredLevels[0].label}($$${triggeredLevels[0].price}) ${triggeredLevels[0].action || '观察'}`
          : `多价位确认: ${triggeredLevels.map(l=>`${l.label}($${l.price})`).join('、')}`
      };
    } catch (error) {
      console.error(`[❌${COIN}数据收集错误]`, error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-${data.coin}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.altcoin.model;
    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', model,
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${data.coin}警报触发] 已派发即时分析: ${jobName} | 确认价位: ${data.triggeredLevels.length}个`);

    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};
