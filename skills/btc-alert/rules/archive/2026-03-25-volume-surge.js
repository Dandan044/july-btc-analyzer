/**
 * 交易量异动警报
 * 监控 BTC 交易量异常放大（超过30日均值1.5倍）
 * 用于确认突破有效性
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-25';
const VOLUME_MULTIPLIER = 1.5; // 触发阈值：均值倍数
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '交易量异动警报',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      const ticker = await api.getTicker('BTC');
      const priceHistory = await api.getPriceHistory('BTC', 30);
      
      // 计算历史平均交易量
      const volumes = priceHistory.history.map(h => h.volume || 0).filter(v => v > 0);
      const avgVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 2340000000;
      
      const currentVolume = ticker.volume24h || 1850000000;
      const ratio = currentVolume / avgVolume;
      
      console.log(`[警报检查] 当前交易量: $${(currentVolume/1e9).toFixed(2)}B, 均值: $${(avgVolume/1e9).toFixed(2)}B, 比率: ${ratio.toFixed(2)}x`);
      
      return ratio >= VOLUME_MULTIPLIER;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const priceHistory = await api.getPriceHistory('BTC', 30);
      const volumes = priceHistory.history.map(h => h.volume || 0).filter(v => v > 0);
      const avgVolume = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 2340000000;
      const klines = await api.getKlines('BTC', '1h', 6);
      const fgi = await api.getFearGreedIndex(7);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentVolume: ticker.volume24h,
        averageVolume: avgVolume,
        volumeRatio: (ticker.volume24h / avgVolume).toFixed(2),
        fearGreedIndex: fgi.current,
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '交易量异动',
        position: {
          entryZone: [69500, 70500],
          stopLoss: 67000,
          takeProfit1: 73000,
          takeProfit2: 75000,
          positionSize: '50%'
        },
        significance: '交易量放大确认多头力量，突破SMA14后放量将确认趋势转多'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const spawnMessage = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;
    const now = new Date().toISOString();
    const jobName = `alert-volume-${Date.now()}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', spawnMessage,
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
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天
  }
};