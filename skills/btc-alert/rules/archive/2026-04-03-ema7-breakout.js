/**
 * EMA7突破确认警报-67295
 * 监控 BTC 价格突破 EMA7 后的回踩确认
 * 
 * 背景：分析发现市场从"单边下跌"转为"震荡筑底"，建议 sug-002 等待突破 EMA7 $67,295 后回踩确认入场。
 * 使用延迟触发机制：突破后等待30分钟观察是否回踩守住。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-03';
const TARGET_PRICE = 67295;
const DELAY_MS = 30 * 60 * 1000; // 突破后等待30分钟
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'EMA7突破确认警报-67295',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  breakthroughTime: null,  // 记录突破时间
  breakthroughPrice: null,  // 记录突破时价格

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;

      // 价格突破 EMA7（允许±$100误差）
      if (currentPrice >= TARGET_PRICE - 100) {
        if (!this.breakthroughTime) {
          this.breakthroughTime = Date.now();
          this.breakthroughPrice = currentPrice;
          console.log(`[突破触及] 价格突破 ${TARGET_PRICE} 区域，当前: ${currentPrice}，开始计时...`);
        }

        // 检查是否已延迟足够时间
        if (Date.now() - this.breakthroughTime >= DELAY_MS) {
          // 确认价格仍在突破区域上方（回踩守住）
          if (currentPrice >= TARGET_PRICE - 150) {
            console.log(`[突破确认] 价格守住 ${TARGET_PRICE} 区域 ${DELAY_MS / 60000} 分钟，触发警报`);
            return true;
          }
        }

        const elapsedMs = Date.now() - this.breakthroughTime;
        const elapsedMins = Math.floor(elapsedMs / 60000);
        console.log(`[等待确认] 突破已持续 ${elapsedMins} 分钟，等待 ${DELAY_MS / 60000} 分钟`);
      } else {
        // 价格回落至突破区域下方，重置计时
        if (this.breakthroughTime) {
          console.log(`[突破失败] 价格回落至 ${currentPrice}，重置计时`);
          this.breakthroughTime = null;
          this.breakthroughPrice = null;
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
        breakthroughTime: this.breakthroughTime ? new Date(this.breakthroughTime).toISOString() : null,
        breakthroughPrice: this.breakthroughPrice,
        delayMinutes: DELAY_MS / 60000,
        alertType: 'EMA7突破确认',
        suggestionId: 'sug-002',
        significance: `价格突破 EMA7 $${TARGET_PRICE} 后守住 ${DELAY_MS / 60000} 分钟，趋势反转信号确认。建议入场位 $66,500-$67,000，止损 $65,000，止盈 $68,500/$70,000。`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-ema7-${Date.now()}`;
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
    this.breakthroughTime = null;
    this.breakthroughPrice = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};