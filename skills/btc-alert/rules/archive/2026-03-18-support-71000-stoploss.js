/**
 * 支撑位跌破警报 - $71,000 (止损位)
 * 监控 BTC 价格跌破 $71,000
 * 当前持仓止损位，跌破需要执行离场
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-18';
const TARGET_PRICE = 71000;
const COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却（止损更重要）

module.exports = {
  name: '支撑位跌破警报-71000-止损位',
  interval: 3 * 60 * 1000, // 3分钟检查一次（止损更紧急）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查-止损] 当前价格: ${ticker.price}, 止损位: ${TARGET_PRICE}`);
      return ticker.price <= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      return false;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '5m', 20); // 5分钟K线，更精细
      const fgi = await api.getFearGreedIndex(7);
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h, '7d': ticker.change7d },
        volume24h: ticker.volume24h,
        fearGreedIndex: fgi.current,
        klines5m: klines.map(k => ({ time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
        triggerPrice: TARGET_PRICE,
        alertType: '支撑位跌破-止损位'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      return { alertTime: new Date().toISOString(), error: error.message };
    }
  },

  async trigger(data) {
    const message = `即时分析\n${JSON.stringify(data, null, 2)}`;
    spawn('openclaw', ['agent', '--agent', 'july', '--message', message], { detached: true, stdio: 'ignore' });
    console.log('[警报触发-止损] 已发送即时分析任务');
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const daysDiff = Math.floor((new Date(today) - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};