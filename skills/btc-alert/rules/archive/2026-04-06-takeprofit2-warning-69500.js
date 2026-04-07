/**
 * 止盈2预警警报
 * 监控价格接近止盈2 $70,000
 * 当价格涨至 $69,500 时提前预警（止盈2下方$500）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-06';
const TARGET_PRICE = 69500; // 止盈2预警价位
const TAKEPROFIT_PRICE = 70000; // 实际止盈2
const COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却

module.exports = {
  name: '止盈2预警警报-69500',
  interval: 3 * 60 * 1000, // 3分钟检查
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[止盈2预警检查] 当前价格: ${ticker.price}, 预警位: ${TARGET_PRICE}, 止盈2: ${TAKEPROFIT_PRICE}`);
      
      // 价格涨至预警位以上触发
      return ticker.price >= TARGET_PRICE;
    } catch (error) {
      console.error('[止盈2预警检查错误]', error.message);
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
        takeprofitWarning: TARGET_PRICE,
        actualTakeprofit: TAKEPROFIT_PRICE,
        distanceToTakeprofit: TAKEPROFIT_PRICE - ticker.price,
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
        alertType: '止盈2预警',
        message: `价格接近止盈2 $${TAKEPROFIT_PRICE}，当前距离约 $${(TAKEPROFIT_PRICE - ticker.price).toFixed(0)}`
      };
    } catch (error) {
      console.error('[止盈2预警数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `takeprofit2-warning-${Date.now()}`;
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

    console.log(`[止盈2预警触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // 止盈2预警警报有效期：持仓期间持续有效
    // 如果价格已触及止盈2或已平仓，则失效
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    
    // 有效期7天（持仓期间持续监控）
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};