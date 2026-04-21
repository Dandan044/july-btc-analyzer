/**
 * 做空入场提醒 - $74,500-$74,800 阻力区间
 * 监控 BTC 价格反弹至 $74,500-$74,800 区间后，延迟15分钟确认阻力有效
 * 触发条件：价格触及 $74,500 后又回落，且15分钟内未重新站上
 *
 * ========== 当前状态 ==========
 * 价格: ~$74,474 | $74,500 已跌破成阻力
 * 监控: 价格反弹至 $74,500-$74,800 区间，确认阻力后触发做空提醒
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const TARGET_ZONE_LOW = 74400;
const TARGET_ZONE_HIGH = 74900;
const CONFIRMATION_MS = 15 * 60 * 1000; // 15分钟延迟确认
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

let touchedZone = null; // 记录何时触及区间

module.exports = {
  name: '做空入场-74500阻力区间',
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

      // 情况1：价格进入阻力区间
      if (price >= TARGET_ZONE_LOW && price <= TARGET_ZONE_HIGH) {
        if (touchedZone === null) {
          touchedZone = Date.now();
          console.log(`[警报检查] 价格进入阻力区间: ${price}, 开始计时15分钟确认`);
        }
        // 情况2：价格在区间内，等待15分钟确认
        if (touchedZone !== null && Date.now() - touchedZone >= CONFIRMATION_MS) {
          // 延迟确认后再次检查是否仍在区间（阻力有效）
          if (price >= TARGET_ZONE_LOW && price <= TARGET_ZONE_HIGH) {
            console.log(`[警报检查] 阻力区间确认: ${price}, 触发警报`);
            return true;
          } else {
            // 价格离开区间，重置
            touchedZone = null;
          }
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
        targetZone: [TARGET_ZONE_LOW, TARGET_ZONE_HIGH],
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '做空入场-阻力区间确认',
        significance: '价格反弹至$74,500-$74,800斐波那契阻力区间，延迟15分钟确认阻力有效后触发',
        recommendation: '阻力确认后考虑做空：止损$75,100，止盈$73,500/$73,000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-short-entry-${Date.now()}`;
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
