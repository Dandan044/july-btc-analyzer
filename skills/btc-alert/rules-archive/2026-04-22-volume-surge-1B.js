/**
 * 4H成交量激增警报
 * 触发条件：4小时K线成交量超过 $1,000,000,000（10亿美元）
 * 触发后：执行即时分析，评估大资金动向
 * 
 * 依据：04-22 04:00 K线成交量 $899M（反弹量能），若成交量持续放大，
 *       需判断是大资金进场还是离场，结合价格方向决定方向
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const VOLUME_THRESHOLD = 1e9; // $1B
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '4H成交量激增警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      const klines = await api.getKlines('BTC', '4h', 3);
      if (!klines || klines.length === 0) return false;
      
      // 最新一根4H K线的成交量
      const latestKline = klines[klines.length - 1];
      const volumeUSD = latestKline.volume * latestKline.close; // 估算USD成交量
      const triggered = volumeUSD >= VOLUME_THRESHOLD;
      console.log(`[警报检查] ${this.name} | 最新4H成交量: $${(volumeUSD/1e9).toFixed(2)}B | 阈值: $1B | 触发: ${triggered}`);
      return triggered;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines4h = await api.getKlines('BTC', '4h', 8);
      const klines1h = await api.getKlines('BTC', '1h', 12);
      const priceHistory = await api.getPriceHistory('BTC', 14);
      
      // 计算14日平均成交量
      const avgVolume = priceHistory.volumes && priceHistory.volumes.length > 0
        ? priceHistory.volumes.reduce((a, b) => a + b, 0) / priceHistory.volumes.length
        : 0;
      
      const latestKline = klines4h[klines4h.length - 1];
      const latestVolumeUSD = latestKline.volume * latestKline.close;
      
      // 判断方向：价格涨还是跌
      const priceChange = ((latestKline.close - latestKline.open) / latestKline.open * 100).toFixed(2);
      const direction = priceChange > 0 ? '向上' : priceChange < 0 ? '向下' : '横盘';
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        volume24h: ticker.volume24h,
        latest4hKline: {
          time: latestKline.datetime,
          open: latestKline.open,
          high: latestKline.high,
          low: latestKline.low,
          close: latestKline.close,
          volume: latestKline.volume,
          volumeUSD: latestVolumeUSD,
          change: priceChange,
          direction: direction
        },
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
          volumeUSD: k.volume * k.close
        })),
        klines1h: klines1h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        avg14dVolumeUSD: avgVolume * priceHistory.prices[priceHistory.prices.length - 1],
        triggerThreshold: '$1B',
        alertType: '成交量激增（非价格）',
        significance: `4H成交量 $${(latestVolumeUSD/1e9).toFixed(2)}B，价格${direction} ${Math.abs(priceChange)}%，大资金${direction === '向上' ? '可能正在进场' : '可能正在离场'}`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-volume-surge-${Date.now()}`;
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

    console.log(`[警报触发] ${this.name} | 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
