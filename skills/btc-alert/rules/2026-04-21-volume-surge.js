/**
 * 非价格警报：交易量异动警报
 * 监控 BTC 24h成交额异常放大（超过14日均值1.5倍）
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
      // 当前24h成交额（USDT，直接从ticker获取）
      const ticker = await api.getOKXTicker('BTC');
      const currentVolume = ticker.volume24h;

      // 获取历史日均成交额（OKX 1D K线，volCcy单位USDT）
      const priceHistory = await api.getPriceHistory('BTC', 14);
      const actualDays = priceHistory._actualDays || priceHistory.volumes.length;
      const avgVolume = priceHistory.volumes.reduce((a, b) => a + b, 0) / actualDays;

      const ratio = currentVolume / avgVolume;
      console.log(`[警报检查] 当前24h成交额: $${(currentVolume/1e6).toFixed(2)}M, 日均: $${(avgVolume/1e6).toFixed(2)}M, 比率: ${ratio.toFixed(2)}x`);

      return ratio >= VOLUME_MULTIPLIER;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('BTC');
      const klines = await api.getOKXKlines('BTC', '1H', 6);

      // 历史数据
      const priceHistory = await api.getPriceHistory('BTC', 14);
      const actualDays = priceHistory._actualDays || priceHistory.volumes.length;
      const avgVolume = priceHistory.volumes.reduce((a, b) => a + b, 0) / actualDays;

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentVolume24h: ticker.volume24h,   // USDT成交额
        averageVolume: avgVolume,
        volumeRatio: (ticker.volume24h / avgVolume).toFixed(2),
        historicalDays: actualDays,
        hourlyVolume: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '交易量异动',
        significance: '24h成交额异常放大，可能有大资金进场或离场，需关注价格突破方向'
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
