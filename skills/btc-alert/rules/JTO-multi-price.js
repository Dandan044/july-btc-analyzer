/**
 * JTO 多价位监控警报（延迟确认）
 * 每个价位有独立的确认策略和延迟时间
 * 价格触及价位后等待确认，避免假突破误触发
 *
 * 来源：active/alt-JTO-20260507-0104/reports/alt-report-JTO-2026-05-07-0110.md
 * 报告观点：JTX催化剂驱动的偏多趋势，等待突破$0.44或回调$0.39-0.40入场
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'JTO';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000;
const COIN = 'JTO';

const PRICE_LEVELS = [
  { price: 0.44, type: 'resistance', label: '突破入场触发位($0.44)', action: '放量突破确认→顺势追多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },
  { price: 0.46, type: 'resistance', label: 'TP1/空头清算压力区($0.46)', action: '第一止盈(50%)', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },
  { price: 0.50, type: 'resistance', label: 'TP2/整数关口($0.50)', action: '第二止盈(剩余50%)', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },
  { price: 0.40, type: 'support', label: '回调入场区上沿($0.40)', action: '健康回调至支撑→评估做多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.39, type: 'support', label: '回调入场区下沿/日线38.2%Fib($0.39)', action: '深度回调至强支撑→评估做多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.38, type: 'support', label: '趋势失效位/EMA20($0.38)', action: '跌破→放弃做多计划，重新评估', priority: 'critical',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 }
];

const STABILITY = {
  maxRetracePercent: 0.1,
  resetOnCrossback: true
};

module.exports = {
  name: 'JTO-多价位监控',
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
            const isCrossback = (level.type === 'resistance' && latestPrice < level.price) ||
                               (level.type === 'support' && latestPrice > level.price);
            if (isCrossback) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 假突破，回穿${retrace.toFixed(2)}%，重置`);
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
      console.log(`[🔍JTO警报] [${COIN}] ${this.name} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }
      return false;
    } catch (error) {
      console.error('[❌JTO警报错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      const ticker = await api.getTicker(COIN);
      const klines15m = await api.getKlines(COIN, '15m', 8);
      const klines1h = await api.getKlines(COIN, '1H', 6);

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
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines1h: klines1h.map(k => ({ time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
        alertType: 'JTO多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌JTO数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    if (levels.length === 1) {
      const l = levels[0];
      return l.action ? `${l.label}($${l.price}) ${l.confirmPolicy}, ${l.action}` : `${l.label}($${l.price}) ${l.confirmPolicy}`;
    }
    return `多价位确认触发: ${levels.map(l => `${l.label}($${l.price})`).join('、')}`;
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-${data.coin}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [