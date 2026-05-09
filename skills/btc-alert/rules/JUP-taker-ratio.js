/**
 * JUP Taker买卖比异常警报
 * 监控JUP合约Taker买卖比持续低于阈值（买盘衰竭信号）
 * 
 * 来源: active/alt-JUP-20260509-0304/reports/alt-report-JUP-2026-05-09-0307.md
 * 报告观点: "Taker买卖比持续<0.85表示买盘衰竭警告，需关注"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'JUP';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;

// Taker比值阈值：< 0.85 表示主动卖压占主导
const TAKER_THRESHOLD = 0.85;
// 连续几次检查低于阈值才触发（防止单次异常波动误触）
const CONSECUTIVE_CHECKS = 3;

module.exports = {
  name: 'JUP-Taker卖出占优警报',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,

  // 连续低于阈值计数
  lowRatioCount: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const takerData = await api.getOKXTakerRatio(COIN);
      // takerData 是对象数组，取最新值
      let currentRatio = 1.0;
      if (Array.isArray(takerData) && takerData.length > 0) {
        const latest = takerData[takerData.length - 1];
        currentRatio = typeof latest === 'object' ? (latest.takerRatio || latest.ratio || 1.0) : latest;
      } else if (typeof takerData === 'number') {
        currentRatio = takerData;
      }

      const isLow = currentRatio < TAKER_THRESHOLD;

      if (isLow) {
        this.lowRatioCount++;
      } else {
        this.lowRatioCount = 0; // 恢复则重置
      }

      const triggered = this.lowRatioCount >= CONSECUTIVE_CHECKS;

      console.log(`[🔍警报检查] [API] OKX获取${COIN} Taker买卖比 | [进度] ${this.name} | 当前比: ${currentRatio.toFixed(4)} | 阈值: ${TAKER_THRESHOLD} | 连续低值: ${this.lowRatioCount}/${CONSECUTIVE_CHECKS}次 | 触发: ${triggered} | [来源] 05-09 JUP分析报告: "Taker买卖比若持续<0.85则买盘衰竭，观望"`);

      return triggered;
    } catch (error) {
      console.error('[❌JUP Taker警报错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const takerData = await api.getOKXTakerRatio(COIN);
      const klines1h = await api.getOKXKlines(COIN, '1h', 6, 'SWAP');
      let oiData = null, frData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
        frData = await api.getOKXFundingRate(COIN);
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker?.price || 0,

        alertType: 'JUP Taker卖出占优',
        takerRatio: takerData,
        takerThreshold: TAKER_THRESHOLD,
        consecutiveLowCount: this.lowRatioCount,

        marketData: {
          openInterest: oiData,
          fundingRate: frData
        },

        klines1h: klines1h.map(k => ({
          time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        cycleDir: 'alt-JUP-20260509-0304',
        significance: `JUP Taker买卖比连续${this.lowRatioCount}次检查低于${TAKER_THRESHOLD}，主动卖压持续占优，买盘动能衰竭迹象`
      };
    } catch (error) {
      console.error('[❌JUP Taker数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-JUP-taker-${Date.now()}`;
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

    console.log(`[JUP警报触发] Taker卖出占优警报已派发: ${jobName} | 连续低值: ${this.lowRatioCount}次`);
    this.lastTriggered = Date.now();
    this.lowRatioCount = 0;
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
