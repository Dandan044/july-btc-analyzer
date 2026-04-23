/**
 * 压力位突破警报 - $76,500
 * 触发条件：BTC 价格突破 $76,500（4H收盘）
 * 触发后：执行即时分析，评估是否做多
 * 
 * 依据：三重验证强压（04-17 $77,740、04-21 $76,924、04-22 $76,400）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const TARGET_PRICE = 76500;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '压力位突破警报-76500',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      const ticker = await api.getTicker('BTC');
      const triggered = ticker.price >= TARGET_PRICE;
      console.log(`[警报检查] ${this.name} | 当前价: $${ticker.price} | 目标: $${TARGET_PRICE} | 触发: ${triggered}`);
      return triggered;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '4h', 5);
      const priceHistory = await api.getPriceHistory('BTC', 7);
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': priceHistory.prices.length > 0 
            ? ((ticker.price - priceHistory.prices[priceHistory.prices.length - 1]) / priceHistory.prices[priceHistory.prices.length - 1] * 100).toFixed(2)
            : null
        },
        volume24h: ticker.volume24h,
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerPrice: TARGET_PRICE,
        alertType: '压力位突破（上方价格）',
        significance: '$76,500 为三重验证强压，突破后上方空间打开至 $78,000-$80,000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-76500-${Date.now()}`;
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
