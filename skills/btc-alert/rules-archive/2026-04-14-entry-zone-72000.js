/**
 * 入场机会警报 - $72,000-$72,586支撑区
 * 无持仓状态，监控回调入场机会
 *
 * ========== 当前状态 ==========
 * 无持仓 | 观望
 * 入场区: $72,000-$72,586 ← 本警报监控
 * ==============================
 *
 * 创建原因: 晚间日报分析，大户大幅减仓14.31%，不建议高位追涨，等待回调入场
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-14';
const ENTRY_ZONE_TOP = 72586;
const ENTRY_ZONE_BOTTOM = 72000;
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: '入场机会-72000支撑区',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[入场监控] 当前价格: $${ticker.price}, 入场区: $${ENTRY_ZONE_BOTTOM}-$${ENTRY_ZONE_TOP}`);
      return ticker.price >= ENTRY_ZONE_BOTTOM && ticker.price <= ENTRY_ZONE_TOP;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 8);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        entryZone: [ENTRY_ZONE_BOTTOM, ENTRY_ZONE_TOP],
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '入场机会',
        significance: '价格回调至$72,000-$72,586支撑区，可能存在入场做多机会',
        recommendation: '观察支撑确认：若价格触及后反弹，Taker比回升至1.0+，多空比回升至0.9+，可考虑入场做多。止损$70,500，止盈$75,000/$76,000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-entry72000-${Date.now()}`;
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
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};