/**
 * 支撑位跌破警报 - $68,000
 * 监控 BTC 价格跌破 $68,000 支撑区域
 * 这是3月19日低点区域，跌破后将测试$67,000（止盈目标2）和$64,070（2月24日低点）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-22';
const TARGET_PRICE = 68000;
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: '支撑位跌破警报-68000',
  interval: 5 * 60 * 1000, // 5分钟间隔，减少API调用
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标: ${TARGET_PRICE}`);
      return ticker.price <= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      return false;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const fgi = await api.getFearGreedIndex(7);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': ticker.change7d
        },
        volume24h: ticker.volume24h,
        fearGreedIndex: fgi.current,
        triggerPrice: TARGET_PRICE,
        alertType: '支撑位跌破-68000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      return { alertTime: new Date().toISOString(), error: error.message };
    }
  },

  async trigger(data) {
    const spawnMessage = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'agent',
      '--agent', 'july',
      '--message', spawnMessage
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[警报触发] 已发送即时分析任务: ${data.alertType}`);
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