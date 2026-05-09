/**
 * OP 仓位保护监控（延迟确认）
 * 监控持仓保护价位：止盈触发区、支撑预警、止损线
 *
 * 来源：alt-OP-20260509-0603/reports/alt-report-OP-20260509-0657.md
 * 报告观点：OP 突破确认，已入场做多 @ $0.1744，SL @ $0.156，TP1 @ $0.200，TP2 @ $0.220
 * 触发本次分析的警报：OP-多价位触发（延迟确认）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'OP';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// 多价位配置（≤6个，每个带确认策略）
// 仓位上下文：
//   当前持仓: 228张做多 @ $0.1744
//   止损: $0.156 | TP1: $0.200 | TP2: $0.220
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（止盈区）
  { price: 0.2000, type: 'resistance', label: 'TP1触发区',
    action: '首档止盈接近，评估趋势强度决定是否调整', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.2200, type: 'resistance', label: 'TP2触发区',
    action: '二档止盈接近，评估是否需移动止损锁定利润', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  // 下方价位（风险监控）
  { price: 0.1650, type: 'support', label: '入场下方支撑预警',
    action: '价格跌至入场价下方~5%，检查回调是否演变为反转', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.1560, type: 'support', label: '止损价位触发',
    action: '止损价位接近，趋势验证失败，需评估后续策略', priority: 'critical',
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
  name: 'OP-仓位保护监控',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  levelStates: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getOKXKlines(COIN, '15m', 10);
      if (!klines || klines.length < 2) {
        console.log('[API] OP 15m K线数据不足');
        return false;
      }

      const periodHigh = Math.max(...klines.slice(-3).map(k => k.high));
      const periodLow = Math.min(...klines.slice(-3).map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      // 获取当前价格
      let tickerPrice = latestPrice;
      try {
        const ticker = await api.getOKXTicker(COIN);
        tickerPrice = ticker.price;
      } catch (e) {}

      const allLogs = [];
      const confirmedLevels = [];

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
                allLogs.push(`${level.label}: 假突破回穿${retrace.toFixed(2)}%，重置`);
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
          state.firstTouch = Date.now();
          state.touches = 1;
          state.confirmed = false;
          allLogs.push(`${level.label}: 首次触碰→等待${level.confirmMs/1000}s确认`);
          continue;
        }

        const elapsedMs = Date.now() - state.firstTouch;
        const heldAbove = level.type === 'resistance' ? latestPrice >= level.price :
                         level.type === 'support' ? latestPrice <= level.price : true;

        if (!heldAbove) {
          const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
          if (retrace > STABILITY.maxRetracePercent) {
            state.firstTouch = null;
            state.confirmed = false;
            allLogs.push(`${level.label}: 触碰后回穿${retrace.toFixed(2)}%，取消确认`);
          }
          continue;
        }

        if (elapsedMs >= level.confirmMs) {
          state.confirmed = true;
          confirmedLevels.push({ ...level, elapsedMs, touches: state.touches });
          allLogs.push(`${level.label}: ✅ 确认(${elapsedMs/1000}s)`);
        } else {
          allLogs.push(`${level.label}: 确认中(${elapsedMs/1000}s/${level.confirmMs/1000}s)`);
        }
      }

      if (confirmedLevels.length === 0) {
        console.log(`[API] OP 15m K线检测 | 价格:${tickerPrice} | ${allLogs.join(' | ')}`);
        return false;
      }

      console.log(`[API] OP 15m K线检测 | 价格:${tickerPrice} | 🔔 ${confirmedLevels.map(l => l.label).join(', ')}`);
      console.log(`[API] 确认级别: ${confirmedLevels.map(l => `${l.label}(${l.elapsedMs/1000}s)`).join(', ')}`);

      // 重置所有已确认级别状态
      for (const level of confirmedLevels) {
        this.levelStates[String(level.price)] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
      }

      return true;
    } catch (error) {
      console.error('[API] OP 仓位监控检测出错:', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN);
      const klines = await api.getOKXKlines(COIN, '15m', 14);

      const triggeredLevels = [];
      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        const state = this.levelStates[key];
        if (state && state.confirmed) {
          triggeredLevels.push({
            price: level.price,
            type: level.type,
            label: level.label,
            action: level.action,
            priority: level.priority,
            confirmPolicy: level.confirmPolicy,
            confirmMs: level.confirmMs,
            firstTouchTime: new Date(state.firstTouch || Date.now()).toISOString(),
            confirmedAt: new Date().toISOString(),
            elapsedMs: state.firstTouch ? Date.now() - state.firstTouch : 0
          });
        }
      }

      let priceChange24h = 'N/A';
      try { priceChange24h = ((ticker.change24h || 0) * 100).toFixed(2); } catch (e) {}

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggeredLevels,
        priceChange: { '24h': priceChange24h },
        positionContext: '228张做多 @ $0.1744',
        klines15m: klines.slice(-8).map(k => ({
          time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: `${COIN}-仓位保护触发（延迟确认）`,
        significance: triggeredLevels.length > 0
          ? `${COIN}仓位价位触发: ${triggeredLevels.map(l => `${l.label}($${l.price})`).join(', ')}`
          : `${COIN}无确认级别`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}

以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    this.lastTriggered = Date.now();
    console.log(`[警报触发] OP仓位保护: ${jobName} | ${data.significance}`);
  },

  lifetime() {
    const today = api.getLocalDate();
    return today === '2026-05-09' ? 'active' : 'expired';
  }
};
