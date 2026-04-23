/**
 * 阻力位突破警报
 * 监控 BTC 价格突破 $79,443（即时高点 / 4H 0%斐波那契）
 * 触发后执行即时分析，确认旗形突破是否有效
 * 来源: 04-23 09:05日报 - 上升旗形突破失败后的关键压力
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-23';
const TARGET_PRICE = 79443;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '阻力位突破警报-79443',
  interval: 3 * 60 * 1000, // 3分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;
      const triggered = currentPrice >= TARGET_PRICE;

      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: ${triggered} | [来源] 04-23 09:05日报: "即时高点\$79,443.4为4H 0%斐波那契，已刺穿被拒绝；突破确认需4H收盘高于\$79,443且成交量>\$1,000M"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines4h = await api.getOKXKlines ? await api.getOKXKlines('BTC-USDT-SWAP', '4h', 5) : [];
      const klines15m = await api.getKlines('BTC', '15m', 8);
      const oiData = await api.getOKXOpenInterest();
      const takerData = await api.getOKXTakerRatio();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        triggerPrice: TARGET_PRICE,
        openInterest: oiData.currentOI,
        openInterestChange24h: oiData.change24h,
        takerBuyRatio: takerData.currentRatio,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '阻力位突破',
        significance: '价格突破\$79,443为情景B（向上突破）的确认信号，将触发做多B操作'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-${Date.now()}`;
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
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
