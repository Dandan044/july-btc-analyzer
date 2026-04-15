/**
 * 支撑位跌破警报
 * 监控 BTC 价格跌破关键支撑位 $73,800
 * 跌破后确认空头趋势，可能继续下跌至$73,000/$72,000
 *
 * ========== 当前状态 ==========
 * 无持仓 | 观望等待跌破确认
 * 监控: 价格跌破 $73,800
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-15';
const TARGET_PRICE = 73800;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '支撑位跌破警报-73800',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标: ${TARGET_PRICE}`);
      return ticker.price <= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error; // 必须抛出，让引擎监控到错误
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
        significance: '跌破$73,800关键支撑，确认空头趋势，可能继续下跌至$73,000/$72,000',
        recommendation: '若跌破确认，可考虑做空，止损$74,500，止盈$73,000/$72,000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error; // 必须抛出，让引擎监控到错误
    }
  },

  async trigger(data) {
    // 使用 cron 创建隔离会话，每次警报触发独立分析
    const now = new Date().toISOString();
    const jobName = `alert-support-73800-${Date.now()}`;
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

    // 更新冷却时间
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天
  }
};