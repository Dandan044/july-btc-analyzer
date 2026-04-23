/**
 * 成交量异动警报
 * 触发条件：BTC 1H成交量突然放大超过 7日均值 的 3倍
 * 触发后：执行即时分析，评估是否有大资金进场
 * 
 * 依据：04-22 15:09报告判断"成交量持续萎缩（$74.6M → $22.7M），
 *       横盘整理是暴风雨前的平静，变盘方向不明"。
 *       成交量是变盘的领先指标，若突然放大，往往预示方向选择。
 *       当前缩量横盘，若突然放量，可能是变盘信号。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const VOLUME_MULTIPLIER = 3; // 触发阈值：7日均值3倍
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '成交量异动警报',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      // 获取最近7天的日成交量用于计算均值
      const priceHistory = await api.getPriceHistory('BTC', 7);
      
      if (!priceHistory.volumes || priceHistory.volumes.length < 3) {
        console.log('[🔍警报检查] [API] CryptoCompare获取BTC历史成交量 | [进度] 成交量异动警报 | 状态: 数据不足 | 触发: false | [来源] 04-22 15:09报告: "成交量持续萎缩，变盘方向不明"');
        return false;
      }
      
      // 计算7日平均成交量
      const avgVolume = priceHistory.volumes.reduce((a, b) => a + b, 0) / priceHistory.volumes.length;
      
      // 获取1H K线（最近3根）计算当前成交量
      const klines = await api.getKlines('BTC', '1h', 3);
      const latestVolume = klines[0]?.volume || 0;
      
      const ratio = latestVolume / avgVolume;
      const triggered = ratio >= VOLUME_MULTIPLIER;
      
      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC7日成交量+1H K线 | [进度] ${this.name} | 当前1H成交量: ${(latestVolume/1e6).toFixed(2)}M | 7日均值: ${(avgVolume/1e6).toFixed(2)}M | 倍数: ${ratio.toFixed(2)}x | 阈值: ${VOLUME_MULTIPLIER}x | 触发: ${triggered} | [来源] 04-22 15:09报告: "成交量是变盘领先指标，突然放大预示方向选择"`);
      
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const priceHistory = await api.getPriceHistory('BTC', 7);
      const klines1h = await api.getKlines('BTC', '1h', 12);
      const klines4h = await api.getKlines('BTC', '4h', 4);
      
      const avgVolume = priceHistory.volumes.reduce((a, b) => a + b, 0) / priceHistory.volumes.length;
      const latestVolume = klines1h[0]?.volume || 0;
      const ratio = latestVolume / avgVolume;
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        current1hVolume: latestVolume,
        volumeRatio: ratio.toFixed(2),
        averageVolume7d: avgVolume,
        volume7dHistory: priceHistory.volumes.map((v, i) => ({
          date: priceHistory.dates ? priceHistory.dates[i] : null,
          volume: v
        })),
        klines1h: klines1h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '成交量异动（非价格）',
        significance: `1H成交量突然放大至 ${ratio.toFixed(2)}x 7日均值（${(latestVolume/1e6).toFixed(2)}M vs 均值${(avgVolume/1e6).toFixed(2)}M）。大资金可能正在进场或离场，需关注价格突破方向。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
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

    console.log(`[⚡警报触发] ${this.name} | 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};