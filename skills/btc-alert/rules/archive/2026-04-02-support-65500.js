/**
 * 支撑测试警报-65500
 * 监控 BTC 价格触及支撑区域后的守住确认
 * 
 * 背景：分析发现 $65,500 为关键支撑，建议在守住后确认做多入场。
 * 使用延迟触发机制：价格触及后等待30分钟观察是否守住。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-02';
const TARGET_PRICE = 65500;
const DELAY_MS = 30 * 60 * 1000; // 触及后等待30分钟
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '支撑测试警报-65500',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  touchedTime: null,  // 记录触及时间

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;

      // 价格触及支撑区域（允许±$200误差）
      if (currentPrice <= TARGET_PRICE + 200) {
        if (!this.touchedTime) {
          this.touchedTime = Date.now();
          console.log(`[支撑触及] 价格触及 ${TARGET_PRICE} 区域，当前: ${currentPrice}，开始计时...`);
        }

        // 检查是否已延迟足够时间
        if (Date.now() - this.touchedTime >= DELAY_MS) {
          // 再次确认价格仍在支撑区域上方（守住）
          if (currentPrice >= TARGET_PRICE - 100) {
            console.log(`[支撑确认] 价格守住 ${TARGET_PRICE} 区域 ${DELAY_MS / 60000} 分钟，触发警报`);
            return true;
          }
        }

        const elapsedMs = Date.now() - this.touchedTime;
        const elapsedMins = Math.floor(elapsedMs / 60000);
        console.log(`[等待确认] 触及已持续 ${elapsedMins} 分钟，等待 ${DELAY_MS / 60000} 分钟`);
      } else {
        // 价格反弹离开支撑区域，重置计时
        if (this.touchedTime) {
          console.log(`[支撑离开] 价格反弹至 ${currentPrice}，重置计时`);
          this.touchedTime = null;
        }
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
      const klines = await api.getKlines('BTC', '15m', 10);
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
        triggerPrice: TARGET_PRICE,
        touchedTime: this.touchedTime ? new Date(this.touchedTime).toISOString() : null,
        delayMinutes: DELAY_MS / 60000,
        alertType: '支撑测试确认',
        significance: `价格触及 $${TARGET_PRICE} 支撑区域后守住 ${DELAY_MS / 60000} 分钟，可能入场做多。建议入场位 $65,500，止损 $64,500。`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
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
    this.touchedTime = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 2 ? 'active' : 'expired';
  }
};