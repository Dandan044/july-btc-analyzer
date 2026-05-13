const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'KMNO';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// 多价位监控 - 基于首次分析报告的观察条件
const LEVELS = {
  above: [
    { price: 0.0265, desc: '4H前高突破确认', confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  ],
  below: [
    { price: 0.0231, desc: '4H Fib50%回撤/多头防线', confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    { price: 0.0223, desc: '4H Fib61.8%/止损位', confirmPolicy: 'instant', confirmMs: 0 },
    { price: 0.01965, desc: '4H Fib100%/趋势起点', confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },
  ]
};

// 延迟确认状态存储
const confirmState = {};

module.exports = {
  name: 'KMNO-price-watch',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getOKXTicker(COIN);
      const price = ticker.price;
      const triggeredLevels = [];

      // 检查上方价位
      for (const level of LEVELS.above) {
        if (price >= level.price) {
          if (level.confirmPolicy === 'instant') {
            triggeredLevels.push({ ...level, direction: 'above' });
          } else {
            const key = `above_${level.price}`;
            if (!confirmState[key]) confirmState[key] = Date.now();
            const elapsed = Date.now() - confirmState[key];
            if (elapsed >= level.confirmMs) {
              triggeredLevels.push({ ...level, direction: 'above', confirmedAfter: Math.floor(elapsed / 60000) + 'min' });
            } else {
              console.log(`[🔍警报检查] [API] OKX获取KMNO实时价格 | [进度] ${this.name} | ⬆️${level.desc} $${level.price} | 突破已持续: ${Math.floor(elapsed/60000)}min | 等待确认: ${Math.floor(level.confirmMs/60000)}min | 当前: $${price} | 触发: false`);
            }
          }
        } else {
          const key = `above_${level.price}`;
          if (confirmState[key]) delete confirmState[key];
        }
      }

      // 检查下方价位
      for (const level of LEVELS.below) {
        if (price <= level.price) {
          if (level.confirmPolicy === 'instant') {
            triggeredLevels.push({ ...level, direction: 'below' });
          } else {
            const key = `below_${level.price}`;
            if (!confirmState[key]) confirmState[key] = Date.now();
            const elapsed = Date.now() - confirmState[key];
            if (elapsed >= level.confirmMs) {
              triggeredLevels.push({ ...level, direction: 'below', confirmedAfter: Math.floor(elapsed / 60000) + 'min' });
            } else {
              console.log(`[🔍警报检查] [API] OKX获取KMNO实时价格 | [进度] ${this.name} | ⬇️${level.desc} $${level.price} | 跌破已持续: ${Math.floor(elapsed/60000)}min | 等待确认: ${Math.floor(level.confirmMs/60000)}min | 当前: $${price} | 触发: false`);
            }
          }
        } else {
          const key = `below_${level.price}`;
          if (confirmState[key]) delete confirmState[key];
        }
      }

      const triggered = triggeredLevels.length > 0;

      if (!triggered) {
        const aboveStr = LEVELS.above.map(l => `⬆️$${l.price}`).join(' ');
        const belowStr = LEVELS.below.map(l => `⬇️$${l.price}`).join(' ');
        console.log(`[🔍警报检查] [API] OKX获取KMNO实时价格 | [进度] ${this.name} | 当前: $${price} | ${aboveStr} ${belowStr} | 触发: false | [来源] 05-13 KMNO首次分析: "趋势中后段，$0.0265突破则延续，$0.0231跌破则反转"`);
      }

      if (triggered) {
        this._triggeredLevels = triggeredLevels;
      }
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN);
      const klines4h = await api.getOKXKlines(COIN, '4H', 5);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        change24h: ticker.change24h,
        volume24h: ticker.volume24h,
        triggeredLevels: this._triggeredLevels || [],
        klines4h: klines4h.map(k => ({ time: k.datetime, close: k.close, volume: k.volume }))
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-KMNO-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}
以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};
