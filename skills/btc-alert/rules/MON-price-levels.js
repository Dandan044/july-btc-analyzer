const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'MON';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// 多价位监控 - 做空入场触发 + 关键支撑/阻力
// 更新于 2026-05-13 16:20 即时分析：下跌趋势中段，等待反弹至$0.0314做空
const PRICE_LEVELS = [
  { price: 0.0314, direction: 'up', label: '做空入场触发-4H EMA7/EMA12反弹位', confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.0337, direction: 'up', label: '止损位/5-11前支撑转阻力', confirmPolicy: 'hold', confirmMs: 10 * 60 * 1000 },
  { price: 0.02948, direction: 'down', label: 'TP1-4H 61.8%斐波那契', confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },
  { price: 0.02756, direction: 'down', label: 'TP2-4H 78.6%斐波那契', confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },
];

// 延迟确认状态
const confirmState = {};

module.exports = {
  name: 'MON-多价位监控',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getOKXKlines(COIN, '1m', 3, 'SWAP');
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));

      let triggered = false;
      let triggeredLevel = null;

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        const touched = level.direction === 'up'
          ? periodHigh >= level.price
          : periodLow <= level.price;

        if (touched) {
          if (level.confirmPolicy === 'instant') {
            triggered = true;
            triggeredLevel = level;
            break;
          }

          if (!confirmState[key]) {
            confirmState[key] = Date.now();
          }

          const elapsed = Date.now() - confirmState[key];
          const confirmed = elapsed >= level.confirmMs;

          const elapsedMins = Math.floor(elapsed / 60000);
          const targetMins = Math.floor(level.confirmMs / 60000);

          console.log(`[🔍警报检查] [API] OKX获取MON SWAP 1m K线 | [进度] ${this.name} | ${level.label}: ${level.direction === 'up' ? '高点$' + periodHigh : '低点$' + periodLow} vs $${level.price} | 确认: ${elapsedMins}/${targetMins}min | 策略: ${level.confirmPolicy} | 触发: ${confirmed} | [来源] 05-13 即时分析: "下跌趋势中段，等待反弹至$0.0314做空"`);

          if (confirmed) {
            triggered = true;
            triggeredLevel = level;
            break;
          }
        } else {
          delete confirmState[key];
        }
      }

      if (!triggered) {
        console.log(`[🔍警报检查] [API] OKX获取MON SWAP 1m K线 | [进度] ${this.name} | 高点$${periodHigh} 低点$${periodLow} | 无价位触及 | 触发: false | [来源] 05-13 即时分析: "等待反弹至$0.0314做空"`);
      }

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4H', 3, 'SWAP');
      const klines1h = await api.getOKXKlines(COIN, '1H', 6, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: 'price-level',
        currentPrice: ticker.price,
        kline4h: klines4h.map(k => ({ open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
        kline1h: klines1h.map(k => ({ open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-MON-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理`;

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
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
