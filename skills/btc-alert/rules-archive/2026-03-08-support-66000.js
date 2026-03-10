/**
 * 关键支撑测试警报
 * 监控 BTC 价格触及 $66,000-67,000 关键支撑区间
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

// 警报参数
const CREATED_DATE = '2026-03-08';
const TARGET_PRICE_HIGH = 67000;
const TARGET_PRICE_LOW = 66000;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '关键支撑测试警报-66000-67000',
  interval: 5 * 60 * 1000, // 每5分钟检查一次

  // 冷却状态
  lastTriggered: 0,

  /**
   * 检测条件 - 价格进入$66,000-67,000区间
   */
  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;

      console.log(`[警报检查] 当前价格: ${currentPrice}, 目标区间: $${TARGET_PRICE_LOW}-$${TARGET_PRICE_HIGH}`);

      // 价格在目标区间内触发
      return currentPrice <= TARGET_PRICE_HIGH && currentPrice >= TARGET_PRICE_LOW;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      return false;
    }
  },

  /**
   * 收集数据
   */
  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 5);
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
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        targetZone: `$${TARGET_PRICE_LOW}-$${TARGET_PRICE_HIGH}`,
        alertType: '关键支撑测试'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      return {
        alertTime: new Date().toISOString(),
        error: error.message
      };
    }
  },

  /**
   * 触发动作 - 异步方式
   */
  async trigger(data) {
    const message = `即时分析\n${JSON.stringify(data, null, 2)}`;

    // 异步触发，不阻塞引擎
    spawn('openclaw', ['agent', '--agent', 'july', '--message', message], {
      detached: true,
      stdio: 'ignore'
    });

    console.log('[警报触发] 已发送即时分析任务');

    // 更新冷却时间
    this.lastTriggered = Date.now();
  },

  /**
   * 生命周期检查 - 当日有效
   */
  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};