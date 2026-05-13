/**
 * SSV 多价位监控警报（延迟确认）
 * 来源: alt-report-SSV-2026-05-13-2230.md
 * 报告观点: SSV跌破4H 61.8% Fib($2.906)后加速下行，已开空单(entry=$2.861, SL=$3.063, TP1=$2.804, TP2=$2.547)。
 *          三维共振偏空，sell-the-news效应+技术面破位+多头减仓爆仓。
 *          需监控：止损位、趋势反转信号、止盈目标位。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'SSV';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ⭐ 多价位配置（5个价位）
const PRICE_LEVELS = [
  // 上方价位（做空风险位）
  { price: 3.053, type: 'resistance', label: '止损位/4H 50% Fib回撤',
    action: '止损全平，空单逻辑失效', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },

  { price: 2.906, type: 'resistance', label: '4H 61.8% Fib/原破位位',
    action: '价格回破该位，空头动能减弱，评估减仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 3.144, type: 'resistance', label: '4H 23.6% Fib/趋势反转确认',
    action: '趋势反转确认，空单必须平仓', priority: 'high',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  // 下方价位（做空目标位）
  { price: 2.801, type: 'support', label: '4H 78.6% Fib/TP1附近',
    action: '第一止盈区域，评估部分平仓', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 2.668, type: 'support', label: '4H 100% Fib/波段低点',
    action: '深度目标位，评估全平', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 }
];

// ⭐ 稳定性检查参数（SSV波动率较高，适当放宽）
const STABILITY = {
  maxRetracePercent: 0.3,     // SSV日波动3-5%，0.3%合理
  resetOnCrossback: true
};

module.exports = {
  name: 'SSV-多价位监控',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  // 每个价位的独立确认状态
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

        // Instant: 直接触发
        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT触发`);
          continue;
        }

        // 延迟确认
        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及，开始${level.confirmMs/60000}分钟确认...`);
          continue;
        }

        // 追踪突破深度
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
      console.log(`[🔍警报检查] SSV多价位 | 区间: $${periodLow.toFixed(3)}-$${periodHigh.toFixed(3)} | 当前: $${latestPrice.toFixed(3)} | ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

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

      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getKlines(COIN, '4h', 6);
      let oiData = null, lsData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
        lsData = await api.getOKXLongShortRatio(COIN);
        takerData = await api.getOKXTakerRatio(COIN);
      } catch (e) { /* 静默 */ }

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
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price,
              maxRetracePct: l.confirmPolicy === 'instant' ? null :
                Math.abs((ticker.price - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),

        periodRange: {
          high: Math.max(...klines4h.slice(-3).map(k => k.high)),
          low: Math.min(...klines4h.slice(-3).map(k => k.low))
        },

        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        longShortRatio: lsData?.currentRatio,
        klines4h: klines4h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        alertType: '多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    if (levels.length === 1) {
      const l = levels[0];
      const confirmDesc = l.confirmPolicy === 'instant' ? '立即触发' : `确认${l.confirmMs/60000}分钟后触发`;
      return l.action
        ? `${l.label}($${l.price}) ${confirmDesc}，${l.action}`
        : `${l.label}($${l.price}) ${confirmDesc}`;
    }
    const labels = levels.map(l => `${l.label}($${l.price})`);
    return `多价位确认触发: ${labels.join('、')}`;
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-price-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${COIN}警报触发] 已派发即时分析任务: ${jobName} | 确认触发价位: ${alertData.triggeredLevels.length}个`);
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};
