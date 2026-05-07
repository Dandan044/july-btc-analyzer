/**
 * BILL 多价位延迟确认监控警报
 * 每个价位有独立的确认策略和延迟时间
 * 价格触及价位后等待确认，避免假突破误触发
 *
 * 来源：active/alt-BILL-20260507-1104/reports/alt-report-BILL-2026-05-07-1108.md
 * 报告观点：BILL上线仅2天，双波拉涨后第二次量能不足遭拒绝(0.0808)，
 *           短期偏空但需确认关键位跌破；突破0.081则多头重燃。
 *           当前建议观望，等待以下价位确认方向。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');

const COIN = 'BILL';
const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000; // 整体冷却 1小时

// ============================================================
// 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 0.0810, type: 'resistance', label: '二次拉涨高点突破/做多触发',
    action: '突破确认多头方向，评估做多入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000 },

  // 下方价位
  { price: 0.0630, type: 'support', label: '近期支撑/做空触发',
    action: '跌破确认空头方向，评估做空入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.0580, type: 'support', label: '首次回调低点',
    action: '跌破确认趋势转弱，空头加速', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.0528, type: 'support', label: '历史低点/首发价',
    action: '跌破意味着完全回吐首发涨幅，极端空头', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 }
];

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.5,     // BILL 波动极大，放宽回穿阈值至 0.5%
  resetOnCrossback: true
};

module.exports = {
  name: 'BILL-多价位延迟确认监控',
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
      // 使用 OKX API 获取 K 线（CryptoCompare 可能不支持 BILL）
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

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT触发`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及 $${level.price}，开始${level.confirmMs/60000}分钟确认...`);
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
      console.log(`[🔍BILL警报] [API] OKX获取${COIN} ${klines.length}根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 当前: $${latestPrice.toFixed(4)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-07 11:08交叉验证分析: "观望，等待0.081突破或0.063跌破确认方向"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌BILL警报错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      const ticker = await api.getTicker(COIN);
      const klines15m = await api.getKlines(COIN, '15m', 8);

      // 获取额外合约数据
      let oiData = null, lsRatio = null, takerData = null;
      try {
        const okxBase = 'https://www.okx.com';
        oiData = await api.fetch(`${okxBase}/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D`);
        lsRatio = await api.fetch(`${okxBase}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1D`);
        takerData = await api.fetch(`${okxBase}/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D`);
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange24h: ticker.change24h,

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
            touches: state.touches,
            crossbacks: state.crossbacks
          };
        }),

        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        oiData: oiData ? oiData.data : null,
        lsRatio: lsRatio ? lsRatio.data : null,
        takerData: takerData ? takerData.data : null,

        alertType: 'BILL多价位延迟确认',
        alertSource: '05-07 11:08交叉验证分析报告'
      };
    } catch (error) {
      console.error('[❌BILL数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
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

    console.log(`[${COIN}警报触发] 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
