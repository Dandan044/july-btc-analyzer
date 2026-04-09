/**
 * 阻力位突破警报 - $72,743
 * 来源：btc-report-2026-04-08-0900
 * 分析结论：观望，监控$72,743阻力位突破情况
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-08';
const EXPIRY_DATE = '2026-04-11';
const TARGET_PRICE = 72743;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '阻力位突破警报-72743',
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
        significance: '$72,743阻力位突破，确认上涨趋势，可追多',
        analysisContext: {
          reportId: 'btc-report-2026-04-08-0900',
          direction: 'up',
          recommendation: '突破放量确认可追多'
        }
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-72743-${Date.now()}`;
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
    const today = new Date().toISOString().split('T')[0];
    const expiry = new Date(EXPIRY_DATE);
    const now = new Date();
    // 在有效期内返回 active
    if (now < expiry) {
      return 'active';
    }
    return 'expired';
  }
};