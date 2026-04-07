/**
 * 资金费率转正警报
 * 监控 BTC 资金费率从负值转为正值
 * 来源：btc-report-2026-03-31-2226
 * 
 * 当前状态：费率 -0.0019%（做空情绪强）
 * 意义：若转正，说明做空情绪消退，是做多入场信号
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-31';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// 使用 Binance API 获取资金费率
async function getFundingRate() {
  const url = 'https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT';
  const data = await api.fetch(url);
  return parseFloat(data.lastFundingRate);
}

module.exports = {
  name: '资金费率转正警报',
  interval: 10 * 60 * 1000, // 10分钟检查一次
  lastTriggered: 0,
  
  // 记录上次费率，用于追踪变化
  lastFundingRate: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const fundingRate = await getFundingRate();
      this.lastFundingRate = fundingRate;
      
      console.log(`[警报检查] 当前资金费率: ${(fundingRate * 100).toFixed(4)}%`);
      
      // 费率转正触发
      return fundingRate > 0;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const fundingRate = await getFundingRate();
      const klines = await api.getKlines('BTC', '1h', 6);
      const fgi = await api.getFearGreedIndex(7);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        fundingRate: fundingRate,
        fundingRatePercent: (fundingRate * 100).toFixed(4) + '%',
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        fearGreedIndex: fgi.current,
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '资金费率转正',
        significance: '资金费率从负值转正，说明做空情绪消退，多头开始主导。是做多入场信号。'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-funding-positive-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
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

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // 费率持续正值超过3天则失效（已转势）
    // 费率持续负值超过7天也失效（观望结束）
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    
    // 如果费率已转正并持续，标记完成
    if (this.lastFundingRate && this.lastFundingRate > 0) {
      return 'completed';
    }
    
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};