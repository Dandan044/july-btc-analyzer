/**
 * ONDO 延迟确认多价位监控警报
 *
 * 来源：alt-report-ONDO-2026-05-13-1518.md
 * 报告观点：趋势偏多但处于第一波后回调期，38.2% Fib $0.398 关键支撑测试中。
 *          OI下降多头撤退，盈亏比不足1.2暂不入场，等待更好位置。
 *          观望条件：突破$0.432做多 / 回踩$0.371放量止跌做多 / 跌破$0.344做空
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'ONDO';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// 多价位配置（带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 0.432, type: 'resistance', label: '4H 23.6% Fib/突破确认位',
    action: '站上确认趋势延续，评估做多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.487, type: 'resistance', label: '前高/年度高点',
    action: '突破前高打开上行空间', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 25 * 60 * 1000 },

  // 下方价位
  { price: 0.371, type: 'support', label: '4H 50% Fib/深度回调支撑',
    action: '回踩止跌评估做多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.344, type: 'support', label: '4H 61.8% Fib/趋势结构破位',
    action: '跌破趋势结构受损，评估做空', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 }
];

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.15,    // 山寨币波动更大，允许0.15%回穿
  resetOnCrossback: true
};

module.exports = {
  name: 'ONDO-多价位监控',
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

        // 检查确认时间
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
      console.log(`[🔍警报检查] ONDO | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌警报检查错误] ONDO:', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      const ticker = await api.getOKXTicker(COIN);
      const klines15m = await api.getOKXKlines(COIN, '15m', 8);

      let lsData = null;
      try {
        lsData = await api.getOKXLongShortRatio(COIN);
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
          high: Math.max(...klines15m.slice(-3).map(k => k.high)),
          low: Math.min(...klines15m.slice(-3).map(k => k.low))
        },

        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        longShortRatio: lsData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        alertType: '多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌数据收集错误] ONDO:', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    const labels = levels.map(l => `${l.label}($${l.price}, ${l.confirmPolicy})`);
    return `多价位确认触发: ${labels.join('、')}`;
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
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
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
