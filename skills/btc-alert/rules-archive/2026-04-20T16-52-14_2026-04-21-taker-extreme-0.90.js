/**
 * Taker买卖比极端警报
 * 监控 OKX Taker 买卖比跌破 0.90（极端卖方主导）
 */
const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CREATED_DATE = '2026-04-21';
const TAKER_THRESHOLD = 0.90;
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
module.exports = {
  name: 'Taker买卖比极端警报-0.90',
  interval: 15 * 60 * 1000,
  lastTriggered: 0,
  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    try {
      const takerData = await api.getOKXTakerRatio();
      return takerData.currentRatio < TAKER_THRESHOLD;
    } catch (error) { console.error('[警报检查错误]', error.message); throw error; }
  },
  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1h', 6);
      const oiData = await api.getOKXOpenInterest();
      return { alertTime: new Date().toISOString(), currentPrice: ticker.price, klines1h: klines, openInterest: oiData, alertType: 'Taker买卖比极端' };
    } catch (error) { console.error('[数据收集错误]', error.message); throw error; }
  },
  async trigger(data) {
    const now = new Date().toISOString();
    spawn('openclaw', ['cron', 'add', '--agent', 'july', '--session', 'isolated', '--at', now, '--message', `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`, '--name', `alert-${Date.now()}`, '--delete-after-run', '--no-deliver'], { detached: true, stdio: 'ignore' });
    this.lastTriggered = Date.now();
  },
  lifetime() { return new Date().toISOString().split('T')[0] === CREATED_DATE ? 'active' : 'expired'; }
};
