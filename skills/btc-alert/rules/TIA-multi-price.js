/**
 * TIA 多价位监控警报 v2（延迟确认）
 * 基于 2026-05-09 06:39 即时分析报告更新
 * 监控6个关键价位：阻力突破、回调入场、结构破坏、目标位
 *
 * 报告摘要: "趋势向上但短期动能衰减，建议观望等待回调企稳"
 * 观察条件: A(回踩0.41-0.42多) B(突破0.455多) C(跌破0.38空)
 */
const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'TIA';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;

// ⭐ 六个关键价位 + 确认策略（基于06:39即时分析报告）
const PRICE_LEVELS = [
  // ① 阻力突破位 → 做多触发B
  { price: 0.455, type: 'resistance', label: '阻力突破/做多触发B',
    action: '价格站稳0.455+成交量>15M→做多入场，止损0.428', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  // ② 止盈目标2
  { price: 0.470, type: 'resistance', label: '止盈目标2',
    action: '到达目标，评估是否全部平仓', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },

  // ③ 4H fib 78.6%关键回调支撑
  { price: 0.428, type: 'support', label: '4H fib 78.6%/回调支撑',
    action: '价格回踩0.428+OI企稳→做多入场信号(条件A上沿)', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  // ④ 4H fib 61.8%/做多入场A
  { price: 0.411, type: 'support', label: '4H fib 61.8%/做多入场A',
    action: '价格回踩0.41-0.42区间+OI停止下降→做多入场，止损0.38', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  // ⑤ 结构破坏/做空触发C
  { price: 0.380, type: 'support', label: '结构破坏/做空触发C',
    action: '跌破0.38+OI加速下降→做空入场，止损0.42', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  // ⑥ 前低/趋势完全否定
  { price: 0.345, type: 'support', label: '趋势完全否定/前低',
    action: '跌回0.345→本轮上涨趋势完全否定，取消所有做多计划', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 30 * 60 * 1000 }
];

const STABILITY = {
  maxRetracePercent: 0.15,
  minConfirmPercent: 0.05,
  resetOnCrossback: true
};

module.exports = {
  name: 'TIA多价位监控v2',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取 SWAP 合约 K线
      const klines = await api.getOKXKlines(COIN, '1m', 3, 'SWAP');
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
              if (retrace > STABILITY.maxRetracePercent || STABILITY.resetOnCrossback) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 回穿，重置计时`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及，等待${level.confirmMs/60000}分钟`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
        }
        this.breakoutExtremes[key] = level.type === 'resistance'
          ? Math.max(this.breakoutExtremes[key], latestPrice)
          : Math.min(this.breakoutExtremes[key], latestPrice);

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs) {
          if (!state.confirmed) {
            state.confirmed = true;
            confirmedLevels.push(level);
            allLogs.push(`${level.label}: 确认完成(${Math.floor(elapsed/60000)}分钟)`);
          }
        } else {
          allLogs.push(`${level.label}: 确认中(${Math.floor(elapsed/60000)}/${Math.floor(level.confirmMs/60000)}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      console.log(`[🔍警报检查] [API] OKX获取TIA合约1分钟K线 | [进度] ${this.name} | 价格: $${ticker.price} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 06:39 TIA即时分析报告: "观望，等待回调0.41-0.42或突破0.455"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }
      return false;
    } catch (error) {
      console.error('[❌TIA警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines15m = await api.getOKXKlines(COIN, '15m', 8, 'SWAP');
      let oi = null, taker = null, lsr = null;
      try { oi = await api.getOKXOpenInterest(COIN); } catch (e) {}
      try { taker = await api.getOKXTakerRatio(COIN); } catch (e) {}
      try { lsr = await api.getOKXLongShortRatio(COIN); } catch (e) {}

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,

        triggeredLevels: triggeredLevels.map(l => {
          const key = String(l.price);
          const state = this.levelStates[key] || {};
          return {
            price: l.price, type: l.type, label: l.label, action: l.action, priority: l.priority,
            confirmPolicy: l.confirmPolicy, confirmMs: l.confirmMs,
            firstTouchTime: state.firstTouch ? new Date(state.firstTouch).toISOString() : null,
            confirmedAt: new Date(now).toISOString(),
            elapsedMs: state.firstTouch ? now - state.firstTouch : 0,
            stability: {
              touches: state.touches || 0, crossbacks: state.crossbacks || 0,
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price
            }
          };
        }),

        periodRange: { high: Math.max(...klines15m.slice(-3).map(k => k.high)), low: Math.min(...klines15m.slice(-3).map(k => k.low)) },
        openInterest: oi?.currentOI,
        takerBuyRatio: taker?.currentRatio,
        longShortRatio: lsr?.currentRatio,

        alertType: 'TIA多价位触发v2（延迟确认）',
        significance: triggeredLevels.length > 0
          ? `TIA价位触发: ${triggeredLevels.map(l=>`${l.label}($${l.price},${l.confirmPolicy})`).join('、')}`
          : '无触发'
      };
    } catch (error) {
      console.error('[❌TIA数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${alertData.coin}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.altcoin.model;
    spawn('openclaw', [
      'cron', 'add', '--agent', 'july',
      '--model', model,
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run', '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[TIA警报触发v2] 已派发即时分析任务: ${jobName} | 触发价位: ${alertData.triggeredLevels?.length || 0}个`);
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
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
