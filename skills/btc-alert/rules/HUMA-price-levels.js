/**
 * HUMA 延迟确认多价位监控警报
 * 监控回调企稳确认和趋势反转信号
 *
 * 来源：alt-report-HUMA-2026-05-13-0138.md
 * 报告观点：Taker恢复+OI未减+价格企稳，回调结束概率增加，条件性做多
 * 入场条件：1H收盘价维持在0.0233以上 + 4H Taker恢复至1.0以上
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// ⭐ 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 0.02441, type: 'resistance', label: '4H 23.6%回撤位/前突破位',
    action: '重新突破确认，做多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.02519, type: 'resistance', label: '4H波段高点/TP1',
    action: '趋势延续确认', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  // 下方价位
  { price: 0.0233, type: 'support', label: '入场区下沿/企稳底线',
    action: '跌破则入场区失效', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.02274, type: 'support', label: '4H 61.8%回撤位/趋势防线',
    action: '跌破确认反弹失败', priority: 'critical',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.02199, type: 'support', label: '4H 50%回撤位/止损位',
    action: '止损触发', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 }
];

// ============================================================
// ⭐ 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.1,
  resetOnCrossback: true
};

module.exports = {
  name: 'HUMA-延迟确认多价位监控',
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
      const klines = await api.getOKXKlines('HUMA', '1m', 3, 'SWAP');
      const periodHigh = Math.max(...klines.map(k => parseFloat(k[2])));
      const periodLow = Math.min(...klines.map(k => parseFloat(k[3])));
      const latestPrice = parseFloat(klines[klines.length - 1][4]);

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
      console.log(`[🔍警报检查] [API] OKX获取HUMA 3根1分钟K线(SWAP) | [进度] ${this.name} | 区间: $${periodLow.toFixed(5)}-$${periodHigh.toFixed(5)} | 当前: $${latestPrice.toFixed(5)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

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

      const ticker = await api.getOKXTicker('HUMA', 'SWAP');
      const klines4h = await api.getOKXKlines('HUMA', '4h', 3, 'SWAP');
      const klines1h = await api.getOKXKlines('HUMA', '1h', 6, 'SWAP');

      let oiData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest('HUMA');
        takerData = await api.getOKXTakerRatio('HUMA');
      } catch (e) { /* 静默 */ }

      const currentPrice = parseFloat(ticker.last);

      return {
        coin: 'HUMA',
        alertTime: new Date().toISOString(),
        currentPrice: currentPrice,

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
              breakoutExtreme: this.breakoutExtremes[key] || currentPrice,
              maxRetracePct: l.confirmPolicy === 'instant' ? null :
                Math.abs((currentPrice - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),

        klines4h: klines4h.map(k => ({
          time: new Date(parseFloat(k[0])).toISOString(),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        })),
        klines1h: klines1h.map(k => ({
          time: new Date(parseFloat(k[0])).toISOString(),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5])
        })),
        openInterest: oiData,
        takerRatio: takerData,

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
    const labels = levels.map(l => `${l.label}($${l.price}, ${l.confirmPolicy})`);
    return `多价位确认触发: ${labels.join('、')}`;
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-HUMA-${Date.now()}`;
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

    console.log(`[HUMA警报触发] 已派发即时分析任务: ${jobName} | 确认触发价位: ${alertData.triggeredLevels.length}个 | 确认策略: ${alertData.triggeredLevels.map(l=>l.confirmPolicy).join(',')}`);

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