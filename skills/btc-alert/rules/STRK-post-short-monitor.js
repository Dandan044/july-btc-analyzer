/**
 * STRK 仓后监控警报（做空持仓）
 * 监控止损逼近、止盈到达、关键技术位
 * 当前持仓：523张空单 @ $0.05758，SL $0.0602，TP1 $0.0520，TP2 $0.0480
 * 
 * 来源：alt-report-STRK-20260509-0026.md
 * 开仓逻辑：v5暴涨后冷却，反弹做空，Taker<0.95确认弱反弹
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'STRK';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;

// 仓后监控价位（5个价位，<=6限制）
const PRICE_LEVELS = [
  // --- 上方：止损逼近预警 ---
  { price: 0.0597, type: 'resistance', label: 'SL前阻力/今日高点',
    action: '价格接近止损$0.0602，关注是否触发止损或手动干预',
    priority: 'high',
    confirmPolicy: 'instant' },

  // --- 1档止盈 ---
  { price: 0.0520, type: 'support', label: 'TP1止盈区',
    action: '第一档止盈$0.0520到达，261张平仓，剩余262张继续持有',
    priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  // --- 4h 38.2% fib ---
  { price: 0.0513, type: 'support', label: '4h 38.2% fib',
    action: 'TP1附近支撑位，关注是否反弹或继续下探TP2',
    priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  // --- 2档止盈 ---
  { price: 0.0480, type: 'support', label: 'TP2止盈区',
    action: '第二档止盈$0.0480到达，全部平仓，做空策略完成',
    priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  // --- 下方：4h 61.8% fib ---
  { price: 0.0461, type: 'support', label: '4h 61.8% fib',
    action: 'TP2下方深度支撑，关注是否反弹、是否存在左侧做多机会',
    priority: 'low',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 }
];

const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: 'STRK仓后价位监控（做空持仓）',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
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
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 假突破(${retrace.toFixed(2)}%)，重置`);
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
          allLogs.push(`${level.label}: 首次触及，开始${level.confirmMs/60000}分钟确认...`);
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
      console.log(`[🔍仓后监控] STRK 3根1分钟K线 | 持仓做空 @0.05758 SL=0.0602 | 区间: $${periodHigh.toFixed(4)}-$${periodLow.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌仓后监控错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines15m = await api.getOKXKlines(COIN, '15m', 8, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        entryPrice: 0.05758,
        positionSize: 523,
        stopLoss: 0.0602,
        takeProfit1: 0.0520,
        takeProfit2: 0.0480,

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

        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        alertType: 'STRK仓后价位触发',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌仓后数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    const labels = levels.map(l => `${l.label}(\$${l.price})`);
    return `仓后价位触发: ${labels.join('、')} | 持仓: 523空单 @0.05758 SL=0.0602 TP=[0.0520,0.0480]`;
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-STRK-${Date.now()}`;
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

    console.log(`[STRK仓后警报触发] 已派发即时分析任务: ${jobName} | 触发价位: ${data.triggeredLevels.length}个`);

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
    return daysDiff <= 4 ? 'active' : 'expired';
  }
};
