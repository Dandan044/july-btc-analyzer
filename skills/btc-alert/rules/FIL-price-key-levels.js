/**
 * FIL 多价位监控警报（延迟确认）
 * 监控 FIL 关键价位，使用K线区间 + 延迟确认避免假突破
 *
 * 来源：alt-report-FIL-2026-05-09-0709.md
 * 报告观点：FIL 处于 AI 存储叙事行情中段，等待回调 $1.08-1.10 入场或突破 $1.3052 追多
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'FIL';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;

// ============================================================
// ⭐ 多价位配置（6个价位，带独立确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（突破追多方向）
  { price: 1.3052, type: 'resistance', label: '4H Fib 0% / 方案B突破追多',
    action: '进入突破追多评估', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },  // 入场触发，防假突破

  // 下方价位（回调/支撑方向）
  { price: 1.18, type: 'support', label: '日线23.6% Fib / 今日低点',
    action: '触发做多方案A评估', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },  // 入场触发，防假突破

  { price: 1.10, type: 'support', label: '日线38.2% Fib / 方案A回调入场区上沿',
    action: '优先入场做多', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },  // 关键入场区，长确认

  { price: 1.05, type: 'support', label: '5月7日低点 / 趋势结构支撑',
    action: '跌破则趋势破坏，所有看多条件取消', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },  // 结构位，需确认

  { price: 0.945, type: 'support', label: '日线结构破位位 / 多单止损位',
    action: '趋势结构完全破坏', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },  // 止损，INSTANT

  // 上方目标位
  { price: 1.61, type: 'resistance', label: 'BanklessTimes目标位 / 止盈1',
    action: '评估止盈60%', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 }  // 目标位，短确认
];

// 稳定性检查参数
const STABILITY = {
  maxRetracePercent: 0.2,     // 最大回穿幅度 %（山寨币波动大，放宽至0.2%）
  resetOnCrossback: true      // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: `FIL-多价位监控（6级延迟确认）`,
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
      // 获取3根1分钟K线（覆盖3分钟检查间隔），使用SWAP合约
      const klines = await api.getOKXKlines('FIL', '1m', 3, 'SWAP');
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

        // 追踪突破深度
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
      console.log(`[🔍警报检查] [API] OKX FIL-SWAP 3根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-09 FIL报告: "FIL处于AI存储叙事行情中段，等待回调$1.08-1.10入场或突破$1.3052追多"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error(`[❌FIL警报检查错误]`, error.message);
      throw error;
    }
  },

  async collect() {
    const triggeredLevels = this.currentTriggeredLevels || [];
    const now = Date.now();

    try {
      const ticker = await api.getOKXTicker('FIL', 'SWAP');
      const klines15m = await api.getOKXKlines('FIL', '15m', 8, 'SWAP');

      // 尝试获取更多数据
      let oiData = null, takerData = null, lsrData = null;
      try {
        oiData = await api.getOKXOpenInterest('FIL');
      } catch (e) { /* 静默 */ }
      try {
        takerData = await api.getOKXTakerRatio('FIL');
      } catch (e) { /* 静默 */ }
      try {
        lsrData = await api.getOKXLongShortRatio('FIL');
      } catch (e) { /* 静默 */ }

      return {
        coin: 'FIL',
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
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        longShortRatio: lsrData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        alertType: 'FIL多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌FIL数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    if (levels.length === 1) {
      const l = levels[0];
      return l.action
        ? `${l.label}($${l.price}) 确认后，${l.action}`
        : `${l.label}($${l.price}) 确认触发`;
    }
    return `多价位确认触发: ${levels.map(l => `${l.label}($${l.price})`).join('、')}`;
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-FIL-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
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

    console.log(`[FIL警报触发] 已派发即时分析四阶段任务: ${jobName} | 触发价位: ${alertData.triggeredLevels.length}个`);

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
