/**
 * LAYER 延迟确认多价位监控
 * 做空持仓期间监控关键价位
 * 
 * 来源: alt-report-LAYER-2026-05-13-1845
 * 报告观点: 解锁卖压持续，空头主导，5/10脉冲后下跌趋势中段
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'LAYER';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000;

const PRICE_LEVELS = [
  // 上方价位（做空持仓，反弹风险）
  { price: 0.1079, type: 'resistance', label: '5/13日高/反弹阻力',
    action: '反弹受阻确认，空头延续', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.1093, type: 'resistance', label: '5/12反弹高点',
    action: '反弹扩大，评估减仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.1136, type: 'resistance', label: '4H结构位',
    action: '趋势可能反转，需重新评估', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },
  { price: 0.1184, type: 'resistance', label: '4H布林中轨/止损区域',
    action: '止损区域接近，立即关注', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },
  // 下方价位（做空持仓，止盈路径）
  { price: 0.0988, type: 'support', label: '日线78.6%斐波那契',
    action: '接近TP1路径，加速下行确认', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.095, type: 'support', label: '5/9低点/接近ATL',
    action: '深度下行，接近历史低点', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 }
];

const STABILITY = {
  maxRetracePercent: 0.15,  // LAYER波动较大，放宽回穿容忍度
  resetOnCrossback: true
};

module.exports = {
  name: 'LAYER-多价位监控',
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
      console.log(`[🔍警报检查] [API] OKX获取LAYER 3分钟K线(SWAP) | [进度] ${this.name} | 区间: $${periodLow.toFixed(5)}-$${periodHigh.toFixed(5)} | 当前: $${latestPrice.toFixed(5)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-13 LAYER即时分析: "解锁卖压持续，空头主导，5/10脉冲后下跌趋势中段"`);

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
      const klines15m = await api.getOKXKlines(COIN, '15m', 8, 'SWAP');

      let oiData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
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
            price: l.price, type: l.type, label: l.label, action: l.action, priority: l.priority,
            confirmPolicy: l.confirmPolicy, confirmMs: l.confirmMs,
            firstTouchTime: state.firstTouch ? new Date(state.firstTouch).toISOString() : null,
            confirmedAt: new Date(now).toISOString(),
            elapsedMs: state.firstTouch ? now - state.firstTouch : 0,
            stability: {
              touches: state.touches || 0, crossbacks: state.crossbacks || 0,
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price,
              maxRetracePct: l.confirmPolicy === 'instant' ? null :
                Math.abs((ticker.price - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        klines15m: klines15m.map(k => ({
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
      return l.action ? `${l.label}($${l.price}) ${confirmDesc}，${l.action}` : `${l.label}($${l.price}) ${confirmDesc}`;
    }
    return `多价位确认触发: ${levels.map(l => `${l.label}($${l.price}, ${l.confirmPolicy})`).join('、')}`;
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-LAYER-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add', '--agent', 'july', '--session', 'isolated',
      '--at', now, '--message', message, '--name', jobName,
      '--delete-after-run', '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[LAYER多价位警报触发] 已派发即时分析任务: ${jobName} | 确认触发价位: ${data.triggeredLevels.length}个`);
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
