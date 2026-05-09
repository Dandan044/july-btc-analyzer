/**
 * DYDX 空头持仓管理警报（v5）
 * 当前持仓: short 220张 @ $0.18129，SL=$0.192，TP=$0.159/$0.147
 *
 * 来源: active/alt-DYDX-20260508-0304/reports/alt-report-DYDX-2026-05-09-0338.md
 * 报告观点: "反弹至做空区，执行做空，等待二次下跌"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'DYDX';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// 多价位配置（4个关键价位）
// 当前持仓: short @ $0.18129，警报管理开仓后的运行
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（空头风险信号）
  { price: 0.192, type: 'resistance', label: 'SL触发位/空头止损',
    action: '价格触及$0.192止损位，分析是短暂毛刺还是结构转变，评估是否重新做空',
    priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },

  // 下方价位（空头目标位）
  { price: 0.159, type: 'support', label: 'TP1/FIB61.8%',
    action: '价格触及$0.159第一止盈位，分析到达后反弹力度，评估是否延长剩余持仓',
    priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 0.147, type: 'support', label: 'TP2/FIB78.6%',
    action: '价格触及$0.147第二止盈位，空头目标全部完成，分析后市走向',
    priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  // 中价位预警
  { price: 0.165, type: 'support', label: '暴跌低点上沿',
    action: '价格跌至$0.165警戒线（暴跌最低点$0.1653），分析是否放量击穿该关键位置',
    priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 }
];

// 稳定性检查参数
const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: 'DYDX空头持仓管理v5（持短管理）',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  // 每个价位的独立确认状态
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},
  triggeredHistory: [],

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

        // 检测是否触及
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
          this.breakoutExtremes[key] = level.type === 'resistance' ? latestPrice : latestPrice;
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
            const elapsedMins = Math.floor(elapsed / 60000);
            allLogs.push(`${level.label}: 确认完成(${elapsedMins}分钟)`);
          }
        } else {
          const elapsedMins = Math.floor(elapsed / 60000);
          const targetMins = Math.floor(level.confirmMs / 60000);
          allLogs.push(`${level.label}: 确认中(${elapsedMins}/${targetMins}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN} ${klines.length}根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-09 03:38即时分析: "短线已做空，持仓管理"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌DYDX警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      const ticker = await api.getTicker(COIN);
      const klines15m = await api.getKlines(COIN, '15m', 8);
      const priceHistory = await api.getPriceHistory(COIN, 7);

      return {
        coin: COIN,
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
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price
            }
          };
        }),

        periodRange: {
          high: Math.max(...klines15m.slice(-3).map(k => k.high)),
          low: Math.min(...klines15m.slice(-3).map(k => k.low))
        },

        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        volume24h: ticker.volume24h,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        alertType: 'DYDX空头持仓管理v5',
        alertDescription: 'DYDX空头仓位触及关键价位，持仓管理分析'
      };
    } catch (error) {
      console.error('[❌DYDX数据收集错误]', error.message);
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

    this.triggeredHistory.push({
      time: new Date().toISOString(),
      levels: alertData.triggeredLevels
    });

    console.log(`[${alertData.coin}警报触发v5] 已派发即时分析任务: ${jobName} | 触发价位: ${alertData.triggeredLevels.length}个`);
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
