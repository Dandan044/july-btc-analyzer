/**
 * 支撑位跌破警报
 * 监控 BTC 价格跌破 $77,500（今日低点 $77,544 附近 / 关键支撑）
 * 跌破将触发情景C（深度回踩），目标 $74,980 / $73,596
 * 来源: 04-23 09:05日报 - $77,500是多杀多踩踏触发点
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-23';
const TARGET_PRICE = 77500;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '支撑位跌破警报-77500',
  interval: 3 * 60 * 1000, // 3分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;
      const triggered = currentPrice < TARGET_PRICE;

      console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: ${triggered} | [来源] 04-23 09:05日报: "今日低点\$77,544为强支撑，跌破将破坏4H结构，触发情景C深度回踩，目标\$74,980/\$73,596"`);

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
        alertType: '支撑位跌破',
        significance: '价格跌破\$77,500为情景C（多杀多踩踏）触发信号，将执行做空操作，目标\$74,980'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-${Date.now()}`;
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
