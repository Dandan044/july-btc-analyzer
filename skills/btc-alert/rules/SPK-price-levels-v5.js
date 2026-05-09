/**
 * SPK 多价位监控（延迟确认）- v5
 * 更新于即时分析后（2026-05-09 09:31）
 * 来源: alt-report-SPK-20260509-0931.md
 * 观点: "结构已从缩量冬眠切换至筑底复苏，偏多但等待更好入场点"
 * - $0.0385已触发（v4），移除
 * - $0.0400保留做多触发
 * - 新增$0.0385作为回踩支撑位
 * - 新增$0.03772（5-09回踩低点）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'SPK';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;

// ============================================================
// 多价位配置（v5 更新：09:31 即时分析，结构转向偏多）
// 当前价格: $0.03915   OI: 2.38M（触底回升）  LSR: 1.45-1.50
// 入场策略: 方案A(回踩$0.038-0.0385确认) / 方案B(放量突破$0.040追多)
// ============================================================
const PRICE_LEVELS = [
  // === 上方价位：阻力突破 → 做多触发 ===
  { price: 0.04000, type: 'resistance', label: '关键阻力/方案B做多触发',
    action: '做多评估（15m量>80K+Taker>1.2确认）', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.04078, type: 'resistance', label: '日线50%斐波那契/过度拉伸位',
    action: '顶部预警（观察量能是否配合）', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 25 * 60 * 1000 },

  // === 下方价位：支撑测试 → 回踩做多 / 破位做空 ===
  { price: 0.03850, type: 'support', label: '突破回踩支撑/方案A入场区上沿',
    action: '做多评估（OI站2.35M+Taker>1.0确认）', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.03772, type: 'support', label: '5-09早间回踩低点/方案A止损参考',
    action: '做空评估（跌破则结构转弱）', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.03700, type: 'support', label: '5-08深夜盘整支撑',
    action: '深度回调预警（多空比回归信号）', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.03668, type: 'support', label: '周期底部/结构防守位',
    action: '底部破位预警（转空评估）', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 25 * 60 * 1000 }
];

const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: `${COIN}多价位监控v5`,
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
          allLogs.push(`${level.label}: 触及，开始${Math.floor(level.confirmMs/60000)}分钟确认`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
        }
        this.breakoutExtremes[key] = level.type === 'resistance'
          ? Math.max(this.breakoutExtremes[key], latestPrice)
          : Math.min(this.breakoutExtremes[key], latestPrice);

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs && !state.confirmed) {
          state.confirmed = true;
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: 确认完成(${Math.floor(elapsed/60000)}分钟)`);
        } else if (!state.confirmed) {
          allLogs.push(`${level.label}: 确认中(${Math.floor(elapsed/60000)}/${Math.floor(level.confirmMs/60000)}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN}USDT-SWAP 3根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-09 09:31即时分析: "结构转向偏多，等待入场方案A/B"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      const klines15m = await api.getOKXKlines(COIN, '15m', 8, 'SWAP');

      let oiData = null, takerData = null;
      try {
        const oiResult = await api.getOKXOpenInterest(COIN);
        oiData = oiResult.history;
      } catch(e) {}

      try {
        const takerResult = await api.getOKXTakerRatio(COIN);
        takerData = takerResult.history;
      } catch(e) {}

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: klines15m[klines15m.length-1]?.close || 0,
        triggeredLevels: triggeredLevels.map(l => {
          const key = String(l.price);
          const state = this.levelStates[key] || {};
          return {
            price: l.price, type: l.type, label: l.label, action: l.action,
            priority: l.priority, confirmPolicy: l.confirmPolicy, confirmMs: l.confirmMs,
            firstTouchTime: state.firstTouch ? new Date(state.firstTouch).toISOString() : null,
            confirmedAt: new Date(now).toISOString(),
            elapsedMs: state.firstTouch ? now - state.firstTouch : 0,
            stability: {
              touches: state.touches || 0, crossbacks: state.crossbacks || 0,
              breakoutExtreme: this.breakoutExtremes[key] || 0
            }
          };
        }),
        periodRange: {
          high: Math.max(...klines15m.map(k => k.high)),
          low: Math.min(...klines15m.map(k => k.low))
        },
        openInterest: oiData,
        takerData: takerData,
        klines15m: klines15m,
        alertType: `${COIN}多价位触发v5（延迟确认）`,
        significance: triggeredLevels.length === 1
          ? `${triggeredLevels[0].label}($${triggeredLevels[0].price}) ${triggeredLevels[0].confirmPolicy}确认${Math.floor(triggeredLevels[0].confirmMs/60000)}分钟`
          : `${COIN} ${triggeredLevels.length}个价位确认触发: ${triggeredLevels.map(l => l.label).join(', ')}`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
    const model = CONFIG.trigger.altcoin.model;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[${COIN}警报触发] 已派发即时分析任务: ${jobName} | ${data.triggeredLevels?.length || 0}个价位确认`);
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
