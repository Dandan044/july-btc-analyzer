/**
 * ROBO 仓位风控多价位监控警报（v2）
 * 即时分析后更新：活跃空头仓位监控
 * 仓位: short 18 lots @ $0.0221, SL=$0.02347, TP1=$0.02156, TP2=$0.02071
 * 监控止损位、关键支撑/阻力的突破或跌破
 *
 * 来源: active/alt-ROBO-20260508-0905/reports/alt-report-ROBO-2026-05-08-1016.md
 * 报告观点: "4H 38.2%回调位$0.02240确认跌破，条件触发开空，关注TP1/TP2及风险"
 * 说明: v1($0.02240已触发并执行) → v2(侧重仓位风控监控)
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'ROBO';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// 多价位配置（6个价位，带确认策略）
// 仓位: short 18 lots @ $0.0221
// 当前价: ~$0.02213
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（止损/阻力）
  { price: 0.02347, type: 'resistance', label: '空头止损位/SL',
    action: '价格逼近空头止损$0.02347，需立即分析是否调整止损或认错平仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 10 * 60 * 1000 },

  { price: 0.02260, type: 'resistance', label: '破位结构回测/多空临界',
    action: '价格回测$0.02260区域，若站稳则空头结构弱化，需重新评估', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  // 下方价位（支撑/止盈）
  { price: 0.02156, type: 'support', label: 'TP1/4H 50%回调位',
    action: '价格触及第一止盈$0.02156，接近目标，评估是否有延长持有空间', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },

  { price: 0.02071, type: 'support', label: 'TP2/4H 61.8%回调位',
    action: '价格触及第二止盈$0.02071，本轮空头目标已全部达到', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },

  { price: 0.02000, type: 'support', label: '整数关口/心理支撑',
    action: '价格跌破$0.02000整数关口，空头加速确认，关注是否超跌反弹', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.01940, type: 'support', label: 'EMA20均线/深度支撑',
    action: '价格回落至EMA20($0.01940)，深度回调目标达成，评估短线反弹机会', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 }
];

// 稳定性检查参数
const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: 'ROBO仓位风控监控v2',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

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
      console.log(`[🔍警报检查] [API] OKX获取${COIN} ${klines.length}根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(5)}-$${periodHigh.toFixed(5)} | 当前: $${latestPrice.toFixed(5)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [仓位] ROBO short 18张 @ 0.0221 | [来源] 即时分析10:16报告`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌ROBO风控警报错误]', error.message);
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

        alertType: 'ROBO仓位风控触发（延迟确认v2）',
        alertDescription: 'ROBO价格触及风控关键价位（SL/TP/结构位），请进行即时分析评估'
      };
    } catch (error) {
      console.error('[❌ROBO风控数据收集错误]', error.message);
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

    console.log(`[${alertData.coin}仓位风控触发v2] 已派发即时分析任务: ${jobName} | 价位: ${alertData.triggeredLevels.map(l => `$${l.price}`).join(', ')} | 仓位: ROBO short 18张 @ 0.0221`);
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const nowDate = new Date(today);
    const daysDiff = Math.floor((nowDate - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
