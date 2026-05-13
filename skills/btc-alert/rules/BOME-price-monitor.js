const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'BOME';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown

// Multi-price monitoring levels
const LEVELS = [
  { price: 0.0006686, direction: 'above', desc: '4H前高突破', confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.00057, direction: 'below', desc: '4H Fib 50%回踩', confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.00055, direction: 'below', desc: '4H Fib 61.8%深回踩', confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.00058, direction: 'below', desc: '4H布林下轨跌破', confirmPolicy: 'hold', confirmMs: 10 * 60 * 1000 },
  { price: 0.0005975, direction: 'below', desc: '止损位', confirmPolicy: 'instant', confirmMs: 0 },
  { price: 0.0006838, direction: 'above', desc: '日线Fib 38.2%', confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },
];

// Track breakthrough start times for each level
const breakthroughStart = {};

module.exports = {
  name: 'BOME-price-monitor',
  interval: 3 * 60 * 1000,

  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getOKXKlines(COIN, '15m', 4, { proxy: 'http://127.0.0.1:7890' });
      if (!klines || klines.length === 0) return false;

      const currentPrice = klines[klines.length - 1].close;
      const high = Math.max(...klines.map(k => k.high));
      const low = Math.min(...klines.map(k => k.low));

      let anyTriggered = false;
      const triggeredLevels = [];

      for (const level of LEVELS) {
        const key = level.price.toString();
        const isBreached = level.direction === 'above' ? currentPrice >= level.price : currentPrice <= level.price;

        if (isBreached) {
          if (!breakthroughStart[key]) {
            breakthroughStart[key] = Date.now();
          }

          const elapsedMs = Date.now() - breakthroughStart[key];
          const elapsedMins = Math.floor(elapsedMs / 60000);
          const targetMins = level.confirmMs / 60000;
          const confirmed = elapsedMs >= level.confirmMs;

          console.log(`[🔍警报检查] [API] OKX获取BOME 15m K线(4根) | [进度] ${level.desc}-${level.price} | 突破已持续: ${elapsedMins}分钟 | 等待确认: ${targetMins}分钟 | 当前价: $${currentPrice.toFixed(7)} | 触发: ${confirmed} | [来源] 05-13 BOME首周期分析: "反弹动能衰减，关注关键价位突破/跌破信号"`);

          if (confirmed) {
            anyTriggered = true;
            triggeredLevels.push({ ...level, currentPrice });
          }
        } else {
          // Reset if price reverts (retrace check)
          if (breakthroughStart[key]) {
            const retracePct = level.direction === 'above'
              ? (breakthroughStart[key] > 0 ? (high - currentPrice) / (high - level.price) : 0)
              : (currentPrice - low) / (level.price - low);
            // Reset if retrace exceeds 50% of the distance
            if (retracePct > 0.5) {
              breakthroughStart[key] = null;
            }
          }
        }
      }

      this._triggeredLevels = triggeredLevels;
      return anyTriggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, { proxy: 'http://127.0.0.1:7890' });
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, { proxy: 'http://127.0.0.1:7890' });

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggeredLevels: this._triggeredLevels || [],
        volume24h: ticker.volume24h,
        klines4h: klines4h ? klines4h.slice(-3) : [],
        alertType: 'price-monitor'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-BOME-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    this.lastTriggered = Date.now();
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};
