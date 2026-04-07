/**
 * 重新突破EMA7警报
 * 监控价格重新突破EMA7 $67,320
 * 用于判断突破后回落是否只是暂时调整
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-05';
const TARGET_PRICE = 67320; // EMA7当前值
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '重新突破EMA7警报-67320',
  interval: 3 * 60 * 1000, // 3分钟检查
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[EMA7突破检查] 当前价格: ${ticker.price}, EMA7目标: ${TARGET_PRICE}`);
      
      // 价格突破EMA7触发
      return ticker.price >= TARGET_PRICE;
    } catch (error) {
      console.error('[EMA7突破检查错误]', error.message);
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
        ema7Target: TARGET_PRICE,
        breakoutMargin: ticker.price - TARGET_PRICE,
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
        alertType: 'EMA7重新突破',
        message: `价格重新突破EMA7 $${TARGET_PRICE}，当前高出约 $${(ticker.price - TARGET_PRICE).toFixed(0)}`
      };
    } catch (error) {
      console.error('[EMA7突破数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `ema7-breakout-${Date.now()}`;
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

    console.log(`[EMA7突破触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // EMA7突破警报有效期：3天
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};