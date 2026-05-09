/**
 * NOT (Notcoin) 多价位监控警报 v4 — 空头趋势延续 & 24h低点跌破后
 * 更新自即时分析: alt-report-NOT-2026-05-09-1042.md
 * 报告观点: "下跌趋势确认，空头持有。24h低点$0.000646已跌破，新低$0.000639。TP$0.000600/$0.000548，SL$0.000680"
 * v3→v4变更: $0.000646改为阻力(已破位,现价在其下方); 新增$0.000639新24h低点支持
 *
 * 更新日期: 2026-05-09 10:44
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const CREATED_DATE = '2026-05-09';
const COIN = 'NOT';
const COOLDOWN_MS = 60 * 60 * 1000;

// ============================================================
// ⭐ 关键价位 — 空头趋势延续监控
// 当前价格: ~$0.000645, 做空入场: $0.0006488
// 止损: $0.0006801, TP1: $0.0006001, TP2: $0.000548
// 日线Fib: high=0.0007702, low=0.0003255
// 最新: 24h低点$0.000639 (10:00小时线新低)
// ============================================================
const PRICE_LEVELS = [
  // ⬆️ 上方阻力 — 空头保护
  { price: 0.000680, type: 'resistance', label: '止损位/23.6%Fib',
    action: 'SL已触发！评估是否重新入场做空', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },

  { price: 0.000665, type: 'resistance', label: '23.6%日线Fib/阻力确认',
    action: '23.6%Fib转换为阻力，回测不破则确认做空趋势', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  // ⬇️ 下方支撑 — 做空盈利监控
  { price: 0.000646, type: 'resistance', label: '24小时低点破位/转为阻力',
    action: '原支撑$0.000646已跌破,现为阻力。回测此位时评估空头延续', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.000639, type: 'support', label: '新24h低点/$0.000639',
    action: '刷新24h低点，评估下行动能是否加速', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 10 * 60 * 1000 },

  { price: 0.000600, type: 'support', label: 'TP1/38.2%日线Fib',
    action: '第一止盈到达，评估剩余仓位策略', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 0.000548, type: 'support', label: 'TP2/50%日线Fib/回撤中位',
    action: '第二止盈到达，评估是否全部平仓', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 }
];

const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: 'NOT多价位监控v4-空头延续',
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
                allLogs.push(`${level.label}: 假突破/${retrace.toFixed(3)}%回穿，重置`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: 紧急触发`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 触及(${level.confirmPolicy}/${level.confirmMs/60000}min确认开始)`);
          continue;
        }

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs && !state.confirmed) {
          state.confirmed = true;
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: ✅确认完成(${Math.floor(elapsed/60000)}min)`);
        } else {
          const elapsedMins = Math.floor(elapsed / 60000);
          const targetMins = Math.floor(level.confirmMs / 60000);
          allLogs.push(`${level.label}: ⏳确认中(${elapsedMins}/${targetMins}min)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN} SWAP 1m K线(3根) | [进度] ${this.name} | 区间: $${periodLow.toFixed(7)}-$${periodHigh.toFixed(7)} | 当前: $${latestPrice.toFixed(7)} | ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-09 10:42 即时分析: "空头延续,24h低点已跌破,持有空仓"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }
      return false;
    } catch (error) {
      console.error(`[❌${COIN}警报检查错误]`, error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines15m = await api.getOKXKlines(COIN, '15m', 4, 'SWAP');

      let fundingData = null;
      try {
        const fundingResult = await api.fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${COIN}-USDT-SWAP`);
        if (fundingResult && fundingResult.data && fundingResult.data[0]) {
          fundingData = {
            rate: parseFloat(fundingResult.data[0].fundingRate),
            nextTime: fundingResult.data[0].nextFundingTime
          };
        }
      } catch (e) { /* 可选 */ }

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
            elapsedMs: state.firstTouch ? now - state.firstTouch : 0,
            stability: {
              touches: state.touches || 0,
              crossbacks: state.crossbacks || 0
            }
          };
        }),

        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        fundingRate: fundingData?.rate,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close
        })),

        alertType: 'NOT多价位触发v4-空头延续（延迟确认）',
        significance: triggeredLevels.map(l => `${l.label}($${l.price})`).join('、')
      };
    } catch (error) {
      console.error(`[❌${COIN}数据收集错误]`, error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-NOT-price-${Date.now()}`;
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
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${COIN}警报触发v4] 已派发即时分析: ${jobName} | 价位: ${alertData.triggeredLevels.length}个`);

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
