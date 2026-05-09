/**
 * FIL 持仓量 (OI) 缩减警报
 * 监控 FIL 持仓量是否大幅缩减，资金出逃信号
 *
 * 来源：alt-report-FIL-2026-05-09-0709.md
 * 报告观点：OI 从 $14.4M 增长至 $29.7M，是新资金持续入场的标志。
 *          若 OI 跌破 $20M 则意味着资金大幅流出，趋势动能枯竭。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'FIL';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;

// OI 缩减阈值
const OI_THRESHOLD = 20 * 1000 * 1000; // $20M (从峰值 $29.7M 下降约 33%)
const OI_PEAK = 30 * 1000 * 1000;       // $30M (近期高点)

module.exports = {
  name: `FIL-OI缩减警报`,
  interval: 5 * 60 * 1000, // OI 更新不频繁，5分钟检查一次
  lastTriggered: 0,
  // 存储最近几次 OI 读数用于趋势判断
  oiHistory: [],

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest('FIL');
      const currentOI = oiData.currentOI; // 假设返回 USDT 计价的 OI
      const currentOIActual = oiData.oiUsd || currentOI;

      // 记录 OI 历史
      this.oiHistory.push({ time: Date.now(), oi: currentOIActual });
      if (this.oiHistory.length > 12) this.oiHistory.shift(); // 保持最近12个数据点

      // 计算 OI 变化率
      const oiChangePct = ((currentOIActual - OI_PEAK) / OI_PEAK * 100).toFixed(1);
      const triggered = currentOIActual < OI_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取FIL持仓量OI | [进度] ${this.name} | 当前OI: $${(currentOIActual/1e6).toFixed(2)}M | 峰值: $${(OI_PEAK/1e6).toFixed(1)}M | 阈值: $${(OI_THRESHOLD/1e6).toFixed(1)}M | 变化: ${oiChangePct}% | 触发: ${triggered} | [来源] 05-09 FIL报告: "OI从$14.4M翻倍至$29.7M，若跌破$20M则资金外流"`);

      return triggered;
    } catch (error) {
      console.error(`[❌FIL-OI警报检查错误]`, error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('FIL', 'SWAP');
      const klines15m = await api.getOKXKlines('FIL', '15m', 8, 'SWAP');
      const oiData = await api.getOKXOpenInterest('FIL');
      const currentOI = oiData.oiUsd || oiData.currentOI;

      let takerData = null, lsrData = null;
      try { takerData = await api.getOKXTakerRatio('FIL'); } catch (e) { }
      try { lsrData = await api.getOKXLongShortRatio('FIL'); } catch (e) { }

      return {
        coin: 'FIL',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,

        oiData: {
          currentOI: currentOI,
          peakOI: OI_PEAK,
          threshold: OI_THRESHOLD,
          oiChangePct: ((currentOI - OI_PEAK) / OI_PEAK * 100).toFixed(1),
          oiHistory: this.oiHistory
        },

        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        takerBuyRatio: takerData?.currentRatio,
        longShortRatio: lsrData?.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        alertType: 'FIL-OI缩减警报',
        significance: `FIL OI 从峰值 $30M 缩减至 $${(currentOI/1e6).toFixed(2)}M，资金正在离场，趋势动能可能枯竭`
      };
    } catch (error) {
      console.error('[❌FIL-OI数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-FIL-oi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
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

    console.log(`[FIL-OI警报触发] 已派发即时分析四阶段任务: ${jobName} | OI: $${(alertData.oiData.currentOI/1e6).toFixed(2)}M`);

    this.lastTriggered = Date.now();
    this.oiHistory = [];
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
