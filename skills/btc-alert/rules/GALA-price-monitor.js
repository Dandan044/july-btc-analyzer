/**
 * GALA 多价位监控规则
 * 
 * 监控价格区间突破/跌破，覆盖入场、趋势验证和止盈观察
 * 
 * 来源: alt-report-GALA-2026-05-08-2308.md
 * 核心结论: 「三重共振看多，但等待回调入场的最佳时机。入场条件：价格回调至 $0.00396-$0.00405 且企稳」
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'GALA';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// 监听价位及确认策略
const LEVELS = [
  // 上方 - 突破追入
  { price: 0.00452, direction: 'above', tag: '突破追入-新高', confirmMs: 15 * 60 * 1000, desc: '今日高点突破，确认后追入做多' },
  // 下方 - 入场区域
  { price: 0.00396, direction: 'below', tag: '入场区域-回调', confirmMs: 20 * 60 * 1000, desc: '4H 38.2%斐波那契回调位，到达后观察企稳信号入场' },
  // 下方 - 趋势失效
  { price: 0.00360, direction: 'below', tag: '趋势失效-离场', confirmMs: 0, desc: '跌破4月下旬震荡平台上沿，看多逻辑失效' },
  // 上方 - 止盈观察
  { price: 0.00480, direction: 'above', tag: '止盈观察-TP1', confirmMs: 5 * 60 * 1000, desc: '第一档止盈位50%' },
  // 上方 - 第二止盈观察
  { price: 0.00530, direction: 'above', tag: '止盈观察-TP2', confirmMs: 5 * 60 * 1000, desc: '第二档止盈位50%' },
];

module.exports = {
  name: 'GALA-多价位监控',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  // 存储每个价位的突破状态（内存持久化）
  breakthroughState: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker(COIN);
      const currentPrice = ticker.price;

      // 检查每个价位
      for (const level of LEVELS) {
        const stateKey = `${level.direction}_${level.price}`;
        const state = this.breakthroughState[stateKey] || { startedAt: 0, triggered: false };

        // 是否满足基础触发条件
        const hitCondition = level.direction === 'above'
          ? currentPrice >= level.price
          : currentPrice <= level.price;

        if (hitCondition && !state.triggered) {
          // 开始计时
          if (state.startedAt === 0) {
            state.startedAt = Date.now();
            this.breakthroughState[stateKey] = state;
          }

          const elapsedMs = Date.now() - state.startedAt;

          // 延迟确认期满
          if (elapsedMs >= level.confirmMs) {
            state.triggered = true;
            this.breakthroughState[stateKey] = state;
            this._triggerPrice = level.price;
            this._triggerTag = level.tag;
            this._triggerDesc = level.desc;

            console.log(`[🔍警报检查] [API] OKX获取${COIN}当前价格 | [进度] ${this.name} | 价位: $${level.price} (${level.tag}) | 当前价: $${currentPrice} | 确认时间: ${level.confirmMs/1000}秒 | 触发: true | [来源] alt-report-GALA-2026-05-08: "${level.desc}"`);
            return true;
          } else {
            const remaining = Math.ceil((level.confirmMs - elapsedMs) / 1000);
            console.log(`[🔍警报检查] [API] OKX获取${COIN}当前价格 | [进度] ${this.name} | 价位: $${level.price} (${level.tag}) | 当前价: $${currentPrice} | 待确认: ${remaining}秒 | 触发: false | [来源] alt-report-GALA-2026-05-08: "${level.desc}"`);
          }
        } else {
          // 价格回撤，重置计时
          if (state.startedAt !== 0 && !state.triggered) {
            this.breakthroughState[stateKey] = { startedAt: 0, triggered: false };
          }
        }
      }

      // 没有触发
      console.log(`[🔍警报检查] [API] OKX获取${COIN}当前价格 | [进度] ${this.name} | 当前价: $${currentPrice} | 未触发 | [来源] alt-report-GALA-2026-05-08`);
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker(COIN);
      const klines = await api.getKlines(COIN, '15m', 5);
      const klines1h = await api.getKlines(COIN, '1h', 3);

      return {
        coin: COIN,
        alertName: this.name,
        alertType: 'price',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggerPrice: this._triggerPrice || 0,
        triggerTag: this._triggerTag || '',
        triggerDesc: this._triggerDesc || '',
        priceChange1h: ticker.change1h,
        priceChange24h: ticker.change24h,
        volume24h: ticker.volume24h,
        klines15m: klines,
        klines1h: klines1h
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}

以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行技术分析
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
    ], {
      detached: true,
      stdio: 'ignore'
    });

    this.lastTriggered = Date.now();
    this._triggerPrice = 0;
    this._triggerTag = '';
    this._triggerDesc = '';
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
