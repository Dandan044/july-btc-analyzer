const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'SPK';
const CREATED_DATE = '2026-05-11';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// 多价位监控（延迟确认）— 即时分析后更新
// 当前持仓：做空9张，入场$0.03331，止损$0.03651，TP1 $0.03001(6张)，TP2 $0.02726(3张)
const PRICE_LEVELS = [
  // 上方价位（持仓保护 + 做空观察）
  { price: 0.03650, type: 'above', label: '止损位', action: '止损触发，空头结构破坏', priority: 'high', confirmPolicy: 'instant', confirmMs: 0 },
  { price: 0.04000, type: 'above', label: '4H 0.5回撤位', action: '反弹至阻力区，观察是否需要调整止损', priority: 'medium', confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.04200, type: 'above', label: '4H 0.618回撤位/前高', action: '强阻力确认，趋势反转信号', priority: 'high', confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  // 下方价位（止盈确认 + 深度目标）
  { price: 0.03000, type: 'below', label: 'TP1止盈位/启动点支撑', action: '第一档止盈触发，观察是否继续下行', priority: 'high', confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },
  { price: 0.02726, type: 'below', label: 'TP2止盈位/日线0.786回撤', action: '第二档止盈触发，下行趋势确认', priority: 'high', confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },
];

module.exports = {
  name: 'SPK-价格关键位监控',
  interval: 5 * 60 * 1000, // 5分钟
  lastTriggered: 0,
  levelStates: {},
  breakoutExtremes: {},
  currentTriggeredLevels: [],

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getOKXKlines(COIN, '1m', 5, 'SWAP');
      if (!klines || klines.length === 0) return false;

      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;
      const now = Date.now();

      const confirmedLevels = [];
      const allLogs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        const touched = level.type === 'above'
          ? periodHigh >= level.price
          : periodLow <= level.price;

        if (!touched) {
          delete this.levelStates[key];
          delete this.breakoutExtremes[key];
          allLogs.push(`${level.label}: 未触及`);
          continue;
        }

        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: now, touches: 1, crossbacks: 0 };
          this.breakoutExtremes[key] = level.type === 'above' ? periodHigh : periodLow;
        } else {
          this.levelStates[key].touches++;
        }

        const state = this.levelStates[key];
        const elapsed = now - state.firstTouch;

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          const elapsedMins = Math.floor(elapsed / 60000);
          allLogs.push(`${level.label}: 确认完成(${elapsedMins}分钟)`);
        } else {
          const elapsedMins = Math.floor(elapsed / 60000);
          const targetMins = Math.floor(level.confirmMs / 60000);
          if (elapsed >= level.confirmMs) {
            confirmedLevels.push(level);
            allLogs.push(`${level.label}: 确认完成(${elapsedMins}分钟)`);
          } else {
            allLogs.push(`${level.label}: 确认中(${elapsedMins}/${targetMins}分钟)`);
          }
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN} ${klines.length}根1分钟K线(SWAP) | [进度] ${this.name} | 区间: $${periodLow.toFixed(5)}-$${periodHigh.toFixed(5)} | 当前: $${latestPrice.toFixed(5)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-11 SPK即时分析: "做空9张@0.03331，止损0.03651，TP1 0.03001，TP2 0.02726"`);

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
      const klines4h = await api.getOKXKlines(COIN, '4H', 3, 'SWAP');

      let oiData = null, takerData = null, lsData = null;
      try {
        oiData = await api.fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${COIN}&period=1D`);
        takerData = await api.fetch(`https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1D`);
        lsData = await api.fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${COIN}&period=1D`);
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker?.price || null,

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
          };
        }),

        openInterest: oiData,
        takerRatio: takerData,
        longShortRatio: lsData,
        klines4h: klines4h?.map(k => ({
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

    console.log(`[${COIN}警报触发] 已派发即时分析任务: ${jobName} | 确认触发价位: ${alertData.triggeredLevels?.length || 0}个`);

    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    // ⭐ 触发后即归档（引擎自动移动到 rules-archive/，不会删除文件）
    if (this.lastTriggered > 0) return 'completed';

    // 保底：超过 3 天未触发也归档（过期）
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};