/**
 * 支撑位监控 - $73,500
 * 监控 BTC 价格跌至 $73,500 附近，观察是否企稳
 * 触发条件：价格触及 $73,500 后30分钟内观察是否形成支撑
 *
 * ========== 当前状态 ==========
 * 价格: ~$74,474 | 下降趋势中，目标$73,000
 * 监控: 价格跌至 $73,500 附近，观察支撑效果
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const TARGET_PRICE = 73500;
const CONFIRMATION_MS = 30 * 60 * 1000; // 30分钟延迟确认
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const TOLERANCE = 200; // 容差：$200

let touchedZone = null;

module.exports = {
  name: '支撑位观察-73500',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;

      // 价格触及目标位（容差范围内）
      if (price <= TARGET_PRICE + TOLERANCE && price >= TARGET_PRICE - TOLERANCE) {
        if (touchedZone === null) {
          touchedZone = Date.now();
          console.log(`[警报检查] 价格触及支撑区间: ${price}, 开始计时30分钟确认`);
        }
        // 30分钟后确认是否企稳
        if (touchedZone !== null && Date.now() - touchedZone >= CONFIRMATION_MS) {
          console.log(`[警报检查] 支撑区间确认观察: ${price}, 触发警报`);
          return true;
        }
      } else {
        // 价格离开区间，重置计时
        touchedZone = null;
      }

      return false;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
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
        targetPrice: TARGET_PRICE,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '支撑位观察-73500',
        significance: '价格跌至$73,500斐波那契支撑位附近，延迟30分钟观察是否企稳',
        recommendation: '观察是否形成支撑：若企稳考虑做多；若继续跌破，目标$73,000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-73500-${Date.now()}`;
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
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    // 有效期：最长3天
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
