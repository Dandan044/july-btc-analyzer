/**
 * 支撑位跌破警报 - 突破确认监控
 * 
 * 目的：监控价格是否回落至$74,500以下，若跌破说明突破$75,000失效
 * 
 * 触发条件：
 * - 价格跌破$74,500（向下方向）
 * 
 * 来源：即时分析报告 instant-report-2026-04-16-0338.md
 * 背景：价格突破$75,000，但需要确认是否有效突破。若跌破$74,500，说明突破失效
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-16';
const TARGET_PRICE = 74500;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '支撑位跌破警报-74500',
  interval: 1 * 60 * 1000, // 1分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标支撑: ${TARGET_PRICE}`);
      return ticker.price < TARGET_PRICE;
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
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        triggerPrice: TARGET_PRICE,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '支撑位跌破',
        significance: '价格跌破$74,500，说明突破$75,000可能失效，价格回到突破前区间',
        recommendation: '重新评估市场，等待更明确的方向信号'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-74500-${Date.now()}`;
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
    const hoursDiff = Math.floor((now - created) / (1000 * 60 * 60));
    return hoursDiff <= 24 ? 'active' : 'expired'; // 有效期24小时
  }
};