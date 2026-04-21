/**
 * 非价格警报：交易量异动警报
 * 监控 BTC 小时交易量异常放大（超过14日均值1.5倍）
 * 适用场景：变盘前夕往往伴随放量，捕捉大资金动向
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const VOLUME_MULTIPLIER = 1.5; // 触发阈值：均值倍数
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '交易量异动警报',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取当前交易量（OKX 1H K线聚合24小时）
      const volumeData = await api.get24hVolume('BTC');
      const currentVolume = volumeData.volume24h;

      // 获取14日历史交易量计算均值（OKX 1D K线）
      const priceHistory = await api.getPriceHistory('BTC', 14);
      const avgVolume = priceHistory.volumes.reduce((a, b) => a + b, 0) / 14;

      const ratio = currentVolume / avgVolume;
      console.log(`[警报检查] 当前交易量: $${(currentVolume/1e9).toFixed(2)}B, 14日均值: $${(avgVolume/1e9).toFixed(2)}B, 比率: ${ratio.toFixed(2)}x`);

      return ratio >= VOLUME_MULTIPLIER;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('BTC');
      const volumeData = await api.get24hVolume('BTC');
      const priceHistory = await api.getPriceHistory('BTC', 14);
      const avgVolume = priceHistory.volumes.reduce((a, b) => a + b, 0) / 14;
      const klines = await api.getOKXKlines('BTC', '1H', 6);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentVolume: volumeData.volume24h,
        averageVolume: avgVolume,
        volumeRatio: (volumeData.volume24h / avgVolume).toFixed(2),
        hourlyVolume: volumeData.hourlyData,
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '交易量异动',
        significance: '交易量异常放大，可能有大资金进场或离场，需关注价格突破方向'
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
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
