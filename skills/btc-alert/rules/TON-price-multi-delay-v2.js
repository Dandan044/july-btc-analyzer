/**
 * TON 延迟确认多价位监控警报 (v2)
 * 即时分析触发后更新：$2.58 已突破，入场区调整为 $2.40-$2.45
 *
 * 来源：alt-report-TON-instant-20260507-1040.md
 * 报告观点：Telegram 接管结构性利好叙事持续，趋势完好，但价格极度超涨
 *          入场需等待回调至 $2.40-$2.45，止损 $1.90，止盈 $2.80/$3.00
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'TON';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const COIN = 'TON';
const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000;

// ============================================================
// ⭐ 多价位配置
// ============================================================
const PRICE_LEVELS = [
  // 上方价位 — 止盈/趋势延续
  { price: 2.80, type: 'resistance', label: 'TP1止盈/心理关口',
    action: '触及第一止盈位，评估是否部分止盈', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },

  { price: 3.00, type: 'resistance', label: 'TP2止盈/整数关口',
    action: '触及第二止盈位，评估是否全部止盈', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },

  // 下方价位 — 入场触发区（回调做多）
  { price: 2.45, type: 'support', label: '入场区间上沿(回调做多)',
    action: '回调到入场区上沿，评估开仓做多', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  { price: 2.40, type: 'support', label: '入场区间下沿(回调做多)',
    action: '回调到入场区下沿，评估开仓做多', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  // 下方价位 — 止损
  { price: 1.90, type: 'support', label: '止损位',
    action: '跌破止损位，评估止损平仓', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 }
];

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: `TON-多价位延迟确认(v2)`,
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getOKXKlines(COIN, '1m', 3);
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      const now = Date.now();
      const confirmedLevels = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        let state = this.levelStates[key] || {
          firstTouch: null, lastCheck: now, touches: 0, crossbacks: 0,
          breakoutHigh: null, breakoutLow: null
        };

        const isResistance = level.type === 'resistance';
        const isTouch = isResistance
          ? periodHigh >= level.price
          : periodLow <= level.price;

        if (!isTouch) {
          if (state.firstTouch !== null) {
            this.levelStates[key] = { firstTouch: null, lastCheck: now, touches: 0, crossbacks: 0, breakoutHigh: null, breakoutLow: null };
          }
          continue;
        }

        state.touches++;

        if (state.firstTouch === null) {
          state.firstTouch = now;
          state.breakoutHigh = isResistance ? periodHigh : null;
          state.breakoutLow = !isResistance ? periodLow : null;
        }

        if (isResistance && periodHigh > (state.breakoutHigh || 0)) state.breakoutHigh = periodHigh;
        if (!isResistance && periodLow < (state.breakoutLow || Infinity)) state.breakoutLow = periodLow;

        state.lastCheck = now;

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          this.levelStates[key] = { firstTouch: null, lastCheck: now, touches: 0, crossbacks: 0, breakoutHigh: null, breakoutLow: null };
          continue;
        }

        const stillBroken = isResistance ? latestPrice >= level.price : latestPrice <= level.price;

        if (!stillBroken && STABILITY.resetOnCrossback) {
          const retracePct = isResistance
            ? ((level.price - latestPrice) / level.price) * 100
            : ((latestPrice - level.price) / level.price) * 100;

          if (retracePct > STABILITY.maxRetracePercent) {
            state.crossbacks++;
            this.levelStates[key] = { firstTouch: null, lastCheck: now, touches: 0, crossbacks: 0, breakoutHigh: null, breakoutLow: null };
            continue;
          }
        }

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs) {
          confirmedLevels.push(level);
          this.levelStates[key] = { firstTouch: null, lastCheck: now, touches: 0, crossbacks: 0, breakoutHigh: null, breakoutLow: null };
        } else {
          this.levelStates[key] = state;
        }
      }

      if (confirmedLevels.length === 0) return false;

      this.currentTriggeredLevels = confirmedLevels;
      return true;

    } catch (error) {
      console.error(`[${COIN}警报v2检查错误]`, error.message);
      throw error;
    }
  },

  async collect() {
    const klines = await api.getOKXKlines(COIN, '1m', 1);
    const latestPrice = klines[0].close;

    const triggeredLevels = this.currentTriggeredLevels.map(l => ({
      price: l.price,
      type: l.type,
      label: l.label,
      action: l.action,
      priority: l.priority,
      confirmPolicy: l.confirmPolicy,
      confirmMs: l.confirmMs,
      breakoutDepth: l.type === 'resistance'
        ? { current: latestPrice, exceeded: +(latestPrice - l.price).toFixed(4) }
        : { current: latestPrice, exceeded: +(l.price - latestPrice).toFixed(4) }
    }));

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      currentPrice: latestPrice,
      alertType: '多价位触发（延迟确认）',
      triggeredLevels,
      note: triggeredLevels.map(l => {
        const confirmDesc = l.confirmPolicy === 'instant' ? '立即触发' : `确认${l.confirmMs / 60000}分钟后触发`;
        const dir = l.type === 'resistance' ? '⬆️' : '⬇️';
        return `${dir} $${l.price} (${l.label}, ${l.confirmPolicy} ${confirmDesc})`;
      }).join(' | ')
    };
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [