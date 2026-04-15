/**
 * 持仓止损监控警报
 * 监控 BTC 价格跌破止损位 $74,500
 * 当前持仓：sug-001，入场价 $75,500，止损 $74,500
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-14';
const STOP_LOSS_PRICE = 74500;
const COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却

module.exports = {
  name: '持仓止损监控-74500',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[止损监控] 当前价格: $${ticker.price}, 止损位: $${STOP_LOSS_PRICE}`);
      return ticker.price <= STOP_LOSS_PRICE;
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
        stopLoss: STOP_LOSS_PRICE,
        breakDistance: (STOP_LOSS_PRICE - ticker.price).toFixed(0),
        suggestionId: 'sug-001',
        entryPrice: 75500,
        confirmed: true,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '止损触发',
        message: `价格跌破止损位$${STOP_LOSS_PRICE}，建议检查持仓`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-sl74500-${Date.now()}`;
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