/**
 * 支撑位跌破警报
 * 监控 BTC 价格跌破 $75,277（4小时即时支撑）
 */
const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CREATED_DATE = '2026-04-21';
const SUPPORT_PRICE = 75277;
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
module.exports = {
  name: '支撑位跌破警报-75277',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;
      console.log(`[警报检查] 当前价格: ${price}, 支撑位: ${SUPPORT_PRICE}`);
      return price < SUPPORT_PRICE;
    } catch (error) { console.error('[警报检查错误]', error.message); throw error; }
  },
  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '4h', 6);
      const oiData = await api.getOKXOpenInterest();
      return { alertTime: new Date().toISOString(), currentPrice: ticker.price, supportPrice: SUPPORT_PRICE, klines4h: klines, openInterest: oiData, alertType: '支撑位跌破' };
    } catch (error) { console.error('[数据收集错误]', error.message); throw error; }
  },
  async trigger(data) {
    const now = new Date().toISOString();
    spawn('openclaw', ['cron', 'add', '--agent', 'july', '--session', 'isolated', '--at', now, '--message', `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`, '--name', `alert-${Date.now()}`, '--delete-after-run', '--no-deliver'], { detached: true, stdio: 'ignore' });
    this.lastTriggered = Date.now();
  },
  lifetime() { return new Date().toISOString().split('T')[0] === CREATED_DATE ? 'active' : 'expired'; }
};
