/**
 * 阻力位突破警报 - $75,000
 * 来源：btc-report-2026-04-08-2100
 * 分析结论：日线61.8%斐波那契回调位$74,650为下一目标，$75,000为期权主要阻力位
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-08';
const EXPIRY_DATE = '2026-04-11';
const TARGET_PRICE = 75000;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '阻力位突破警报-75000',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标阻力: ${TARGET_PRICE}`);
      return ticker.price >= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 8);
      const fgi = await api.getFearGreedIndex(7);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': ticker.change7d
        },
        volume24h: ticker.volume24h,
        fearGreedIndex: fgi.current,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerPrice: TARGET_PRICE,
        alertType: '阻力位突破',
        significance: '$75,000阻力位突破，日线61.8%斐波那契回调位$74,650已触及，确认上涨趋势延续',
        analysisContext: {
          reportId: 'btc-report-2026-04-08-2100',
          direction: 'up',
          recommendation: '突破确认后可考虑止盈或追多'
        }
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-75000-${Date.now()}`;
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
    const expiry = new Date(EXPIRY_DATE);
    const now = new Date();
    if (now < expiry) {
      return 'active';
    }
    return 'expired';
  }
};