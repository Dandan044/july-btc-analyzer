/**
 * JUP 多价位监控警报v3（延迟确认 - 修复版）
 * 更新于2026-05-09 03:48 - 即时分析后，调整价位
 * 修复v2中支持位check逻辑缺陷（支持位应检查periodLow而非periodHigh）
 * 监控6个关键价位，使用K线区间数据捕捉瞬时突破
 * 每个价位有独立的确认策略，避免假突破误触发
 *
 * 来源: active/alt-JUP-20260509-0304/reports/alt-report-JUP-2026-05-09-0345.md
 * 报告观点: "三维共振偏多，趋势处于反转早期，观望维持现有17张long@0.2403"
 * SL=0.203, TP1=0.26, TP2=0.29
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'JUP';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// ⭐ 多价位配置（6个价位，带确认策略）
// 当前实盘：17 long @ 0.2403，SL=0.203，TP1=0.26，TP2=0.29
// ============================================================
const PRICE_LEVELS = [
  // ⬆️ 上方价位（突破确认/止盈）
  { price: 0.243, type: 'resistance', label: '4H前高突破',
    action: '突破0.243确认趋势延续，评估加仓', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.257, type: 'resistance', label: 'TP1周线61.8%',
    action: '第一止盈50%', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 0.290, type: 'resistance', label: 'TP2第二止盈',
    action: '第二止盈50%', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  // ⬇️ 下方价位（结构支撑/止损预警）
  { price: 0.225, type: 'support', label: '关键支撑/回调区',
    action: '跌至0.225支撑区，评估是否加仓或减仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.210, type: 'support', label: '深度支撑/止损预警位',
    action: '接近实际止损，立即评估平仓策略', priority: 'critical',
    confirmPolicy: 'hold', confirmMs: 10 * 60 * 1000 },

  { price: 0.203, type: 'support', label: '实际止损位',
    action: '止损触发，即时分析评估', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 }
];

// 稳定性检查参数
const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: 'JUP-多价位监控v3',
  interval: 3 * 60 * 1000,
  lastTriggered: Date.now(), // 刚刚触发过，立即开始冷却
  maxLevelOffsetPercent: 0.5, // 最大允许偏离当前价格比例（50%），防止异常价位触摸

  // 各价位确认状态
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getOKXKlines(COIN, '1m', 3, 'SWAP');
      const periodHigh = Math.max(...klines.map(k => k.high || 0));
      const periodLow = Math.min(...klines.map(k => k.low || Infinity));
      const latestPrice = klines[klines.length - 1]?.close || 0;

      const now = Date.now();
      const confirmedLevels = [];
      const allLogs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
        }
        const state = this.levelStates[key];

        // ✅ 修复：支持位检查 periodLow，阻力位检查 periodHigh
        const wasTouched = level.type === 'resistance'
          ? periodHigh >= level.price
          : periodLow <= level.price;

        if (!wasTouched) {
          if (state.firstTouch && !state.confirmed) {
            // 价格回穿检查
            const isAboveLevel = level.type === 'resistance' ? latestPrice < level.price : latestPrice > level.price;
            if (isAboveLevel) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 回穿${retrace.toFixed(2)}%，重置`);
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
          allLogs.push(`${level.label}: 开始${level.confirmMs/60000}分钟确认`);
          continue;
        }

        // 追踪突破深度
        if (!this.breakoutExtremes[key]) this.breakoutExtremes[key] = latestPrice;
        this.breakoutExtremes[key] = level.type === 'resistance' ?
          Math.max(this.breakoutExtremes[key], latestPrice) :
          Math.min(this.breakoutExtremes[key], latestPrice);

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs && !state.confirmed) {
          state.confirmed = true;
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: 确认(${Math.floor(elapsed/60000)}分钟)`);
        } else if (!state.confirmed) {
          allLogs.push(`${level.label}: 确认中(${Math.floor(elapsed/60000)}/${Math.floor(level.confirmMs/60000)}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN} 3根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-09 JUP即时分析: "维持17long@0.2403, SL=0.203, TP=0.26/0.29"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌JUP警报检查错误v3]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines15m = await api.getOKXKlines(COIN, '15m', 4, 'SWAP');

      let oiData = null, takerData = null, lsRatio = null, frData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
        takerData = await api.getOKXTakerRatio(COIN);
        lsRatio = await api.getOKXLongShortRatio(COIN);
        frData = await api.getOKXFundingRate(COIN);
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker?.price || 0,

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
              breakoutExtreme: this.breakoutExtremes[key] || ticker?.price || 0
            }
          };
        }),

        periodRange: {
          high: Math.max(...klines15m.map(k => k.high || 0)),
          low: Math.min(...klines15m.map(k => k.low || Infinity))
        },

        marketData: {
          openInterest: oiData,
          takerBuyRatio: takerData,
          longShortRatio: lsRatio,
          fundingRate: frData
        },

        klines15m: klines15m.map(k => ({
          time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        cycleDir: 'alt-JUP-20260509-0304',
        alertType: 'JUP多价位触发（延迟确认v3）'
      };
    } catch (error) {
      console.error('[❌JUP数据收集错误v3]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-JUP-${Date.now()}`;
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
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[JUP警报触发v3] 已派发即时分析任务: ${jobName} | 确认触发价位: ${alertData.triggeredLevels?.length || 0}个`);

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
