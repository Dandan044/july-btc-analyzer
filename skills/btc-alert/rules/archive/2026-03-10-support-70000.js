/**
 * 支撑位跌破警报 - $70,000
 * 监控 BTC 价格跌破 $70,000 心理支撑
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-10';
const TARGET_PRICE = 70000;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '支撑位跌破警报-70000',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标: ${TARGET_PRICE}`);
      return ticker.price <= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      return false;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 5);
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
        alertType: '支撑位跌破'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      return { alertTime: new Date().toISOString(), error: error.message };
    }
  },

  async trigger(data) {
    const message = `即时分析\n${JSON.stringify(data, null, 2)}`;

    // 异步触发，不阻塞引擎
    spawn('openclaw', ['agent', '--agent', 'july', '--message', message], {
      detached: true,
      stdio: 'ignore'
    });

    console.log('[警报触发] 已发送即时分析任务');

    // 更新冷却时间
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    // 有效期：3天
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};