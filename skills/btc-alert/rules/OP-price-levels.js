/**
 * OP 多价位监控警报（延迟确认）- v2
 * 监控 OP 的更新价位：入场触发区、突破确认、趋势失效线
 *
 * 来源：alt-OP-20260509-0603/reports/alt-report-OP-2026-05-09-0635.md
 * 报告观点：OP 突破 $0.179（4H 0% Fib / 周线61.8%）确认，等待入场
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'OP';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// 多价位配置（≤6个，每个带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（阻力突破）
  { price: 0.1820, type: 'resistance', label: '4H Fib 0%突破 / Path B入场',
    action: '确认突破，执行追入', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.1870, type: 'resistance', label: '日线50%回撤位/下一目标',
    action: '下一目标位', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  // 中间位（关键枢纽）
  { price: 0.1790, type: 'support', label: '前阻变支撑 / 周线61.8%',
    action: '支撑强度测试', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  // 下方价位（支撑/入场区）
  { price: 0.1700, type: 'support', label: '4H EMA / Path A入场上沿',
    action: '入场区确认·上沿', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.1650, type: 'support', label: '4H 23.6%回调 / Path A入场核心',
    action: '评估入场做多', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.1490, type: 'support', label: '4H 50%回调 / 趋势失效线',
    action: '趋势失效，放弃做多', priority: 'critical',
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
  name: 'OP-多价位监控v2',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  levelStates: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取K线数据用于价位检测（使用 15m K线的高低点）
      const klines = await api.getOKXKlines(COIN, '15m', 10);
      if (!klines || klines.length < 2) {
        console.log('[API] OP 15m K线数据不足');
        return false;
      }

      const latest = klines[klines.length - 1];
      const previous = klines[klines.length - 2];
      const periodHigh = Math.max(
        ...klines.slice(-3).map(k => k.high)
      );
      const periodLow = Math.min(
        ...klines.slice(-3).map(k => k.low)
      );
      const latestPrice = latest.close;

      // 获取当前价格
      let tickerPrice = latestPrice;
      try {
        const ticker = await api.getOKXTicker(COIN);
        tickerPrice = ticker.price;
      } catch (e) {
        // 使用K线收盘价作为备选
      }

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

        // 延迟确认逻辑
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

      // 更新冷却
      this.lastTriggered = Date.now();

      // 为每个确认级别重置状态，允许重新检测
      for (const level of confirmedLevels) {
        this.levelStates[String(level.price)] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
      }

      return true;
    } catch (error) {
      console.error('[API] OP 价位检测出错:', error.message);
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
            elapsedMs: state.firstTouch ? Date.now() - state.firstTouch : 0,
            stability: {
              touches: state.touches,
              crossbacks: state.crossbacks
            }
          });
        }
      }

      // 获取价格变化
      let priceChange24h = 'N/A';
      try { priceChange24h = ((ticker.change24h || 0) * 100).toFixed(2); } catch (e) {}

      // 获取OI和Taker数据
      let openInterest = null;
      let takerRatio = null;
      try {
        const oi = await api.getOKXOpenInterest(COIN);
        openInterest = oi.openInterest;
      } catch (e) {}
      try {
        const taker = await api.getOKXTakerRatio(COIN);
        takerRatio = taker.takerRatio;
      } catch (e) {}

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggeredLevels,
        priceChange: { '24h': priceChange24h },
        openInterest,
        takerRatio,
        klines15m: klines.slice(-8).map(k => ({
          time: k.time,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: `${COIN}-多价位触发（延迟确认）`,
        significance: triggeredLevels.length > 0
          ? `${COIN}多价位确认触发: ${triggeredLevels.map(l => `${l.label}($${l.price}, ${l.action})`).join(', ')}`
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
    ], {
      detached: true,
      stdio: 'ignore'
    });

    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    return today === '2026-05-09' ? 'active' : 'expired';
  }
};
