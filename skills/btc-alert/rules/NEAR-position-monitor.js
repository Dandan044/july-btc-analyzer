/**
 * NEAR 持仓监控多价位延迟确认警报
 * 监控止盈位、关键支撑/阻力，每个价位带独立确认策略
 *
 * 来源：active/alt-NEAR-20260507-0204/reports/alt-report-NEAR-2026-05-07-1015.md（即时分析更新）
 * 持仓状态：LONG 2.7张@1.475，止损1.349，止盈1.599/1.699
 * 报告观点：三维共振偏多，EMA多头排列完好，OI扩张配合。当前回调正常，$1.43是关键支撑
 * 本次更新：移除已触发$1.47(当前价已低于)，新增$1.50恢复确认位
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'NEAR';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// ⭐ 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 1.70, type: 'resistance', label: 'TP2/止盈第二档',
    action: '第二止盈触发(剩余1.4张)', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 1.60, type: 'resistance', label: 'TP1/止盈第一档',
    action: '第一止盈触发(1.3张)', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 1.55, type: 'resistance', label: '趋势延续/前高附近加仓确认区',
    action: '突破前高后评估是否追加入场', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  { price: 1.50, type: 'resistance', label: '恢复确认位/回调结束信号',
    action: '反弹突破$1.50确认买盘回归，趋势恢复健康', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  // 下方价位
  { price: 1.43, type: 'support', label: '4H Fib 38.2%/趋势质量关键支撑',
    action: '若跌破评估趋势是否反转，考虑手动减仓', priority: 'critical',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 1.35, type: 'support', label: '止损位/入场止损区域',
    action: '接近止损位，趋势可能反转', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 }
];

// ============================================================
// ⭐ 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.15,    // 最大回穿幅度 %
  resetOnCrossback: true      // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: 'NEAR-持仓监控(多价位延迟确认)',
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
      const klines = await api.getKlines('NEAR', '1m', 3);
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
            const isBackAbove = (level.type === 'resistance' && latestPrice < level.price) ||
                                (level.type === 'support' && latestPrice > level.price);
            if (isBackAbove) {
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
      console.log(`[🔍NEAR持仓监控] [API] OKX 1m K线 | 区间: $${periodLow.toFixed(3)}-$${periodHigh.toFixed(3)} | 当前: $${latestPrice.toFixed(3)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌NEAR持仓监控错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      
      const ticker = await api.getTicker('NEAR');
      const klines15m = await api.getKlines('NEAR', '15m', 8);
      
      let oiData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest('NEAR');
        takerData = await api.getOKXTakerRatio('NEAR');
      } catch (e) { /* 静默 */ }

      return {
        coin: 'NEAR',
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
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        alertType: '多价位触发（持仓监控）',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌NEAR数据收集错误]', error.message);
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

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-NEAR-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [