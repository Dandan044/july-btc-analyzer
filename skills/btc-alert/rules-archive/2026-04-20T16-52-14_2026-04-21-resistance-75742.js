/**
 * 阻力位突破确认警报
 * 监控 BTC 价格突破 $75,742（晚间高点）并延迟确认
 */
const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CREATED_DATE = '2026-04-21';
const TARGET_PRICE = 75742;
const DELAY_MS = 30 * 60 * 1000;
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
let breakthroughTime = null;
module.exports = {
  name: '阻力位突破确认-75742',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;
      if (price >= TARGET_PRICE) {
        if (breakthroughTime === null) breakthroughTime = Date.now();
        if (Date.now() - breakthroughTime >= DELAY_MS) return true;
      } else { breakthroughTime = null; }
      return false;
    } catch (error) { console.error('[警报检查错误]', error.message); throw error; }
  },
  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '4h', 6);
      const oiData = await api.getOKXOpenInterest();
      return { alertTime: new Date().toISOString(), currentPrice: ticker.price, triggerPrice: TARGET_PRICE, klines4h: klines, openInterest: oiData, alertType: '阻力位突破确认' };
    } catch (error) { console.error('[数据收集错误]', error.message); throw error; }
  },
  async trigger(data) {
    const now = new Date().toISOString();
    spawn('openclaw', ['cron', 'add', '--agent', 'july', '--session', 'isolated', '--at', now, '--message', `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`, '--name', `alert-${Date.now()}`, '--delete-after-run', '--no-deliver'], { detached: true, stdio: 'ignore' });
    this.lastTriggered = Date.now();
    breakthroughTime = null;
  },
  lifetime() { return new Date().toISOString().split('T')[0] === CREATED_DATE ? 'active' : 'expired'; }
};
