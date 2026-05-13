/**
 * UMA 持仓量异动警报
 *
 * 来源: alt-report-UMA-2026-05-12-2256.md（即时分析）
 * 报告观点: "OI从529K回升至560K+且Taker卖比>1.5时确认空头资金入场，考虑做空"
 * 当前OI: 529K，监控回升至560K以上
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'UMA';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const TARGET_OI = 560000; // 560K张
const TARGET_TAKER_RATIO = 1.5; // Taker卖比>1.5

module.exports = {
  name: 'UMA-持仓量异动',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN, 'SWAP');
      const currentOI = parseFloat(oiData.openInterest);

      let takerRatio = null;
      try {
        const takerData = await api.getOKXTakerRatio(COIN, 'SWAP');
        takerRatio = parseFloat(takerData.currentRatio);
      } catch (e) { /* 静默 */ }

      // OI回升至560K以上即触发（Taker比作为辅助信号）
      const oiTriggered = currentOI >= TARGET_OI;
      const takerTriggered = takerRatio !== null && takerRatio >= TARGET_TAKER_RATIO;
      const triggered = oiTriggered;

      const takerStr = takerRatio !== null ? `Taker卖比: ${takerRatio.toFixed(2)}` : 'Taker比: 获取失败';
      console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量 | [进度] ${this.name} | 当前OI: ${(currentOI/1000).toFixed(1)}K | 阈值: ${(TARGET_OI/1000).toFixed(0)}K | ${takerStr} | 触发: ${triggered} | [来源] 05-12 UMA即时报告: "OI回升至560K+且Taker卖比>1.5确认空头资金入场"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const oiData = await api.getOKXOpenInterest(COIN, 'SWAP');
      const klines15m = await api.getOKXKlines(COIN, '15m', 8, 'SWAP');

      let takerData = null;
      try {
        takerData = await api.getOKXTakerRatio(COIN, 'SWAP');
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: parseFloat(ticker.price),
        openInterest: {
          currentOI: parseFloat(oiData.openInterest),
          threshold: TARGET_OI,
          change24h: oiData.change24h ? parseFloat(oiData.change24h) : null,
          volume: oiData.volume ? parseFloat(oiData.volume) : null,
          timestamp: new Date().toISOString(),
          history: oiData.history || []
        },
        takerBuyRatio: takerData ? {
          currentRatio: parseFloat(takerData.currentRatio),
          prevRatio: takerData.prevRatio ? parseFloat(takerData.prevRatio) : null,
          buyVolume: parseFloat(takerData.buyVolume),
          sellVolume: parseFloat(takerData.sellVolume),
          change: takerData.change ? parseFloat(takerData.change) : null,
          timestamp: new Date().toISOString(),
          history: takerData.history || []
        } : null,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: parseFloat(k.open), high: parseFloat(k.high),
          low: parseFloat(k.low), close: parseFloat(k.close), volume: parseFloat(k.volume)
        })),
        alertType: '持仓量异动',
        significance: `OI回升至${(parseFloat(oiData.openInterest)/1000).toFixed(1)}K超过阈值${(TARGET_OI/1000).toFixed(0)}K，空头资金入场信号${takerData && parseFloat(takerData.currentRatio) >= TARGET_TAKER_RATIO ? '（Taker卖比' + parseFloat(takerData.currentRatio).toFixed(2) + '>1.5确认）' : ''}`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-oi-${Date.now()}`;
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

    console.log(`[${COIN}警报触发] 持仓量异动: OI=${(data.openInterest.currentOI/1000).toFixed(1)}K | 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
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