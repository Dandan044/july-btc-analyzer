const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'LIGHT';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000;

// 关键价位（来自 alt-report-LIGHT-2026-05-08-0610.md）
const PRICE_LEVELS = [
  { level: 'upper_breakout', price: 0.185, direction: 'above', confirm: 'hold', confirmMs: 20 * 60 * 1000, desc: '放量突破确认——考虑右侧做多' },
  { level: 'lower_breakdown', price: 0.148, direction: 'below', confirm: 'hold', confirmMs: 20 * 60 * 1000, desc: '前低跌破——反弹结束，考虑做空' }
];

module.exports = {
  name: 'LIGHT-关键价位监控',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  breakthroughStates: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 使用 api 模块获取 SWAP 合约 ticker（LIGHT 没有 SPOT 对）
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const currentPrice = ticker.price;
      const currentHigh = ticker.high;
      const currentLow = ticker.low;
      const now = Date.now();

      let anyTriggered = false;

      for (const level of PRICE_LEVELS) {
        const stateKey = level.level;
        const priceHit = level.direction === 'above' 
          ? currentPrice >= level.price 
          : currentPrice <= level.price;

        if (priceHit) {
          // 初始化突破状态
          if (!this.breakthroughStates[stateKey]) {
            this.breakthroughStates[stateKey] = { startTime: now };
          }

          const elapsedMs = now - this.breakthroughStates[stateKey].startTime;
          const confirmed = elapsedMs >= level.confirmMs;

          if (confirmed) {
            anyTriggered = true;
          }

          const elapsedMins = Math.floor(elapsedMs / 60000);
          const targetMins = level.confirmMs / 60000;
          console.log(
            `[🔍警报检查] [API] OKX获取${COIN}-USDT-SWAP实时价格 | ` +
            `[进度] ${this.name}/${level.level} | ` +
            `当前价: $${currentPrice} | 目标: $${level.price} (${level.direction}) | ` +
            `突破已持续: ${elapsedMins}分钟/需${targetMins}分钟 | ` +
            `触发: ${confirmed} | ` +
            `[来源] 05-08 06:10 alt-report: "LSR 3.86极端偏多，观望为主。价格突破$0.185或跌破$0.148可触发再评估"`
          );
        } else {
          // 价格回撤，重置突破状态
          if (this.breakthroughStates[stateKey]) {
            const elapsedMs = now - this.breakthroughStates[stateKey].startTime;
            if (elapsedMs > 60000) {
              console.log(
                `[🔍警报检查] [API] OKX获取${COIN}-USDT-SWAP实时价格 | ` +
                `[进度] ${this.name}/${level.level} | ` +
                `当前价: $${currentPrice} | 目标: $${level.price} (${level.direction}) | ` +
                `触发: false (价格回撤) | ` +
                `[来源] 05-08 06:10 alt-report`
              );
            }
            delete this.breakthroughStates[stateKey];
          }
        }
      }

      return anyTriggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      // 使用 api 模块获取 SWAP 合约数据
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines = await api.getOKXKlines(COIN, '15m', 10, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        high24h: ticker.high,
        low24h: ticker.low,
        vol24h: ticker.volume24h,
        triggeredLevels: PRICE_LEVELS.filter(l => {
          return l.direction === 'above' ? ticker.price >= l.price : ticker.price <= l.price;
        }).map(l => l.level),
        last15mKlines: klines.map(k => ({
          time: k.time,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          vol: k.volumeBTC || k.volume
        }))
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;
    const model = CONFIG.trigger.altcoin.model;
    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', model,
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 14 ? 'active' : 'expired';
  }
};
