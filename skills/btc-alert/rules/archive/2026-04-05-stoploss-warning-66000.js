/**
 * 止损预警警报
 * 监控价格接近止损位 $65,000
 * 当价格跌至 $66,000 时提前预警（止损位上方$1,000）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-05';
const TARGET_PRICE = 66000; // 止损预警价位
const STOPLOSS_PRICE = 65000; // 实际止损位
const COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却（止损预警需要更及时）

module.exports = {
  name: '止损预警警报-66000',
  interval: 3 * 60 * 1000, // 3分钟检查
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[止损预警检查] 当前价格: ${ticker.price}, 预警位: ${TARGET_PRICE}, 止损位: ${STOPLOSS_PRICE}`);
      
      // 价格跌至预警位以下触发
      return ticker.price <= TARGET_PRICE;
    } catch (error) {
      console.error('[止损预警检查错误]', error.message);
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
        stoplossWarning: TARGET_PRICE,
        actualStoploss: STOPLOSS_PRICE,
        distanceToStoploss: ticker.price - STOPLOSS_PRICE,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        fearGreedIndex: fgi.current,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close
        })),
        alertType: '止损预警',
        message: `价格接近止损位 $${STOPLOSS_PRICE}，当前距离约 $${(ticker.price - STOPLOSS_PRICE).toFixed(0)}`
      };
    } catch (error) {
      console.error('[止损预警数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `stoploss-warning-${Date.now()}`;
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

    console.log(`[止损预警触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // 止损预警警报有效期：持仓期间持续有效
    // 如果价格已触及止损位或已平仓，则失效
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    
    // 有效期7天（持仓期间持续监控）
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};