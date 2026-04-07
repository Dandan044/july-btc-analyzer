/**
 * 止损接近预警警报-66300
 * 当价格接近止损位$66,000时提前预警
 * 
 * 背景：当前最低价$66,238距止损$66,000仅差$238（0.36%）。
 * 设定$66,300作为预警位，若触及则发出额外警告，提醒持仓风险。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-02';
const TARGET_PRICE = 66300;
const COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却（预警需要更频繁）

module.exports = {
  name: '止损接近预警-66300',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[预警检查] 当前价格: ${ticker.price}, 目标: ${TARGET_PRICE}`);
      return ticker.price <= TARGET_PRICE;
    } catch (error) {
      console.error('[预警检查错误]', error.message);
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
        low24h: ticker.low24h,
        distanceToStopLoss: ticker.price - 66000,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        volume24h: ticker.volume24h,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerPrice: TARGET_PRICE,
        stopLossPrice: 66000,
        alertType: '止损接近预警',
        significance: '价格已接近止损位$66,000，距止损仅$300以内。持仓风险极高，建议密切关注。'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-warning-${Date.now()}`;
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

    console.log(`[预警触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // 预警警报有效期：持仓期间或止损触发后
    // 当前持仓止损位$66,000，预警位$66,300
    // 有效期设定为1天（持仓濒临止损，需要短期监控）
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 1 ? 'active' : 'expired';
  }
};