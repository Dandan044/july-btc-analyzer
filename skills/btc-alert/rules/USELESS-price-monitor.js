/**
 * USELESS 延迟确认多价位监控警报 (v2)
 * 监控趋势做多持仓的关键价格位，防假突破
 *
 * 来源：active/alt-USELESS-20260507-0804/reports/alt-report-USELESS-2026-05-07-0928.md (即时分析)
 * 报告观点：日线趋势仍偏多但短期动能减弱。Taker背离警示，减仓40%后剩余50张。
 *           若回升突破TP1继续看多，若回调加深需评估剩余仓位。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'USELESS';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const COIN = 'USELESS';
const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000; // 整体冷却 1小时

// ============================================================
// 多价位配置（每个价位带确认策略）v2 — 更新于即时分析后
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 0.0510, type: 'resistance', label: 'TP1/4H前高/日线50%斐波',
    action: '第一止盈触发(50%/25张)，评估是否调整TP2', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 0.0555, type: 'resistance', label: 'TP2/日线38.2%斐波',
    action: '第二止盈触发(全部)，评估是否重新入场', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  // 下方价位（即时分析更新：移除0.04762已破位，新增0.04547和0.04373）
  { price: 0.04547, type: 'support', label: '4H 38.2%斐波/回调加深第一站',
    action: '跌破38.2%斐波，回调加深至中等幅度，评估是否继续减仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.04473, type: 'support', label: '日线61.8%斐波/结构弱化位',
    action: '跌破结构弱化位，趋势可能反转，评估全平或大幅减仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.04373, type: 'support', label: '4H 50%斐波/深度回调位',
    action: '深度回调至50%，逼空逻辑严重削弱，评估是否剩余仓位全平', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.0420, type: 'support', label: '止损位/4H 61.8%斐波',
    action: '全平止损，逼空逻辑彻底失效', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 }
];

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.15,    // 山寨波动大，允许0.15%回穿
  resetOnCrossback: true
};

module.exports = {
  name: 'USELESS多价位监控',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  levelStates: {},
  currentTriggeredLevels: [],

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getOKXKlines(COIN, '1m', 3, 'SWAP');
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;

      const now = Date.now();
      const confirmedLevels = [];
      const logs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false, alerted: false };
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
                state.firstTouch = null;
                state.crossbacks++;
              }
            }
          }
          logs.push(`${level.label}: $${latestPrice} | 未触及 | 目标: $${level.price}`);
          continue;
        }

        // 已触及
        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
        }

        if (state.confirmed || state.alerted) {
          logs.push(`${level.label}: $${latestPrice} | 已确认/已触发 | 目标: $${level.price}`);
          continue;
        }

        const elapsed = now - state.firstTouch;
        const elapsedMins = Math.floor(elapsed / 60000);
        const targetMins = level.confirmMs / 60000;

        if (elapsed >= level.confirmMs) {
          state.confirmed = true;
          confirmedLevels.push({
            price: level.price,
            type: level.type,
            label: level.label,
            action: level.action,
            priority: level.priority,
            touchTime: new Date(state.firstTouch).toISOString(),
            confirmPolicy: level.confirmPolicy,
            confirmMs: level.confirmMs,
            elapsedMs: elapsed
          });
          logs.push(`✅ ${level.label}: 确认完成 | 触及: ${elapsedMins}min前 | 当前: $${latestPrice}`);
        } else {
          logs.push(`⏳ ${level.label}: 等待确认 | 触及: ${elapsedMins}min前 | 剩余: ${targetMins - elapsedMins}min | 当前: $${latestPrice}`);
        }
      }

      const logPrefix = confirmedLevels.length > 0 ? '⚡' : '🔍';
      console.log(`[${logPrefix}警报检查] [API] OKX获取${COIN} 1m K线 | [进度] ${this.name} | ${logs.join(' | ')} | [来源] 05-07 09:28即时分析: "日线趋势偏多但短期动能减弱，Taker背离，减仓40%至50张"`);

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
    const ticker = await api.getOKXTicker(COIN, 'SWAP');
    const oiData = await api.getOKXOpenInterest();

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      currentPrice: ticker.price,
      change24h: ticker.change24h,
      volume24h: ticker.volume24h,
      openInterest: oiData?.current || null,
      triggeredLevels: this.currentTriggeredLevels,
      alertType: '多价位触发（延迟确认）',
      positionContext: '做多 50张(减仓40%后)，均价~0.04822，SL=0.0420，TP1=0.0510(25张)，TP2=0.0555(25张)'
    };
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [