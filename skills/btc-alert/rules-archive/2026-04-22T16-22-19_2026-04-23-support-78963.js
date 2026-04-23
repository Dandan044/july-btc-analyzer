/**
 * 核心支撑跌破警报 - $78,963
 * 触发条件：BTC 价格跌破 $78,963（日线50%，核心支撑）
 * 触发后：执行即时分析，评估旗形假突破/深度回踩风险
 * 
 * 依据：04-23 00:15即时分析报告判断"$78,963 是日线50%，突破后转化为强支撑。
 *       旗形下轨在 $79,000-$78,963。若放量跌破 $78,963 → 旗形假突破信号，
 *       可能深度回踩 $78,500-$77,000。情景C（跌破 $78,963，概率20%）。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-23';
const TARGET_PRICE = 78963;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '核心支撑跌破警报-78963',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;
      const triggered = currentPrice < TARGET_PRICE;

      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: ${triggered} | [来源] 04-23 00:15即时分析: "$78,963是日线50%核心支撑，跌破后深度回踩$78,500-$77,000"`);
      
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines1h = await api.getKlines('BTC', '1h', 8);
      const klines4h = await api.getKlines('BTC', '4h', 4);
      
      // 计算1H成交量
      const avg1hVolume = klines1h.slice(0, 4).reduce((sum, k) => sum + k.volume, 0) / 4;
      const latest1hVolume = klines1h[0]?.volume || 0;

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        volume24h: ticker.volume24h,
        triggerPrice: TARGET_PRICE,
        latest1hVolume: latest1hVolume,
        avg1hVolume: avg1hVolume,
        volumeRatio: (latest1hVolume / avg1hVolume).toFixed(2),
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
        alertType: '下方价格警报',
        significance: `价格跌破 $${TARGET_PRICE}（日线50%核心支撑，旗形假突破信号）。深度回踩目标 $78,500-$77,000。需确认：1H成交量是否放量（>${(avg1hVolume/1e6).toFixed(1)}M均值），若放量跌破 → 确认做空信号；若缩量 → 可能是噪音。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-78963-${Date.now()}`;
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
