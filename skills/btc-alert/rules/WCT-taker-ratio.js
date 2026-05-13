/**
 * WCT Taker买卖比异动警报
 * 
 * 来源：alt-report-WCT-2026-05-13-1451.md
 * 报告观点：4H布林带中轨失守确认偏空，等待反弹至$0.0720-0.0725做空。
 *          做空入场条件需1H Taker比<0.9（卖压确认）。
 *          Taker比是做空入场确认的关键指标。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const COIN = 'WCT';

// Taker比阈值
const TAKER_HIGH_THRESHOLD = 1.3;  // 买压显著增强
const TAKER_LOW_THRESHOLD = 0.9;   // 卖压确认（做空入场条件之一）

module.exports = {
  name: 'WCT-Taker比异动',
  interval: 10 * 60 * 1000, // 10分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const takerData = await api.getOKXTakerRatio(COIN);
      const currentRatio = takerData.currentRatio;
      
      const isHigh = currentRatio >= TAKER_HIGH_THRESHOLD;
      const isLow = currentRatio <= TAKER_LOW_THRESHOLD;
      const isSignificant = isHigh || isLow;
      
      const direction = isHigh ? '买压增强' : isLow ? '危压增强' : '中性';
      
      console.log(`[🔍警报检查] [API] OKX获取${COIN} Taker买卖比 | [进度] ${this.name} | 当前比: ${currentRatio.toFixed(2)} | 阈值: >${TAKER_HIGH_THRESHOLD}或<${TAKER_LOW_THRESHOLD} | 方向: ${direction} | 触发: ${isSignificant} | [来源] alt-report-WCT-2026-05-13-1451: "做空入场需Taker比<0.9确认卖压"`);
      
      return isSignificant;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN);
      const takerData = await api.getOKXTakerRatio(COIN);
      
      let oiData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
      } catch (e) { /* 静默 */ }
      
      const klines1h = await api.getKlines(COIN, '1h', 6);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: 'Taker比异动',
        
        takerBuyRatio: {
          current: takerData.currentRatio,
          thresholdHigh: TAKER_HIGH_THRESHOLD,
          thresholdLow: TAKER_LOW_THRESHOLD,
          direction: takerData.currentRatio >= TAKER_HIGH_THRESHOLD ? '买压增强' : '危压增强'
        },
        
        openInterest: oiData?.currentOI,
        oiChange24h: oiData?.change24h,
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        
        klines1h: klines1h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        significance: `WCT Taker买卖比 ${takerData.currentRatio.toFixed(2)}（${takerData.currentRatio >= TAKER_HIGH_THRESHOLD ? '买压增强>1.3' : '卖压确认<0.9'}），做空入场条件${takerData.currentRatio <= TAKER_LOW_THRESHOLD ? '满足' : '未满足'}`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-taker-${Date.now()}`;
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

    console.log(`[${COIN}警报触发] Taker比异动 | 已派发即时分析任务: ${jobName} | Taker比: ${alertData.takerBuyRatio?.current}`);
    
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
