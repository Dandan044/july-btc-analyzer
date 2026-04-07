/**
 * 止盈2触达警报
 * 监控价格触及止盈2 $70,000
 * 触发后执行止盈2平仓（剩余50%仓位）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-06';
const TARGET_PRICE = 70000; // 止盈2价位
const ENTRY_PRICE = 67225; // 入场价
const COOLDOWN_MS = 10 * 60 * 1000; // 10分钟冷却（止盈位触发需要快速响应）

module.exports = {
  name: '止盈2触达警报-70000',
  interval: 2 * 60 * 1000, // 2分钟检查（接近止盈位需要高频监控）
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[止盈2触达检查] 当前价格: ${ticker.price}, 止盈2: ${TARGET_PRICE}`);
      
      // 价格涨至止盈2触发
      return ticker.price >= TARGET_PRICE;
    } catch (error) {
      console.error('[止盈2触达检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 10);
      const fgi = await api.getFearGreedIndex(7);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggerPrice: TARGET_PRICE,
        entryPrice: ENTRY_PRICE,
        profit: ticker.price - ENTRY_PRICE,
        profitPercent: ((ticker.price - ENTRY_PRICE) / ENTRY_PRICE * 100).toFixed(2),
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
        alertType: '止盈2触达',
        message: `价格触及止盈2 $${TARGET_PRICE}，建议平仓剩余50%仓位，利润约 $${(ticker.price - ENTRY_PRICE).toFixed(0)} (+${((ticker.price - ENTRY_PRICE) / ENTRY_PRICE * 100).toFixed(1)}%)`
      };
    } catch (error) {
      console.error('[止盈2触达数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `takeprofit2-reach-${Date.now()}`;
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

    console.log(`[止盈2触达触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // 止盈2触达警报有效期：持仓期间持续有效
    // 触发后返回 completed
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    
    // 有效期7天（持仓期间持续监控）
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};