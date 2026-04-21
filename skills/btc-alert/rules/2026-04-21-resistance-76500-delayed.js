/**
 * 阻力位突破-延迟确认警报
 * 监控 BTC 价格突破 $76,500 并稳定30分钟
 * 
 * 报告依据：$76,500 是即时阻力位，4H结构形成高点下移形态。
 * 当前价格 $75,520，突破后需延迟确认以避免假突破。
 * 
 * 延迟逻辑：
 * - 价格突破 $76,500 后开始计时
 * - 30分钟后仍站稳 $76,500 则触发（排除假突破）
 * - 若价格回落，重置计时
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const TARGET_PRICE = 76500;
const DELAY_MS = 30 * 60 * 1000; // 突破后等待30分钟确认
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '阻力位突破-延迟确认-76500',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  breakthroughTime: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;

      if (price >= TARGET_PRICE) {
        if (!this.breakthroughTime) {
          this.breakthroughTime = Date.now();
          console.log(`[突破检测] 价格已突破 ${TARGET_PRICE}，开始计时...`);
        }
        
        if (Date.now() - this.breakthroughTime >= DELAY_MS) {
          console.log(`[延迟确认] 突破已稳定 ${DELAY_MS / 60000} 分钟，触发警报`);
          return true;
        }
        
        const elapsedMins = Math.floor((Date.now() - this.breakthroughTime) / 60000);
        console.log(`[等待确认] 突破已持续 ${elapsedMins} 分钟，等待 ${DELAY_MS / 60000} 分钟`);
      } else {
        if (this.breakthroughTime) {
          console.log(`[突破失效] 价格回落至 ${price}，重置计时`);
          this.breakthroughTime = null;
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
      const oiData = await api.getOKXOpenInterest();
      const takerData = await api.getOKXTakerRatio();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume
        },
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
        delayMinutes: DELAY_MS / 60000,
        alertType: '阻力位突破-延迟确认',
        significance: `价格突破 $76,500 后稳定30分钟确认有效，4H结构可能转多`,
        recommendation: '突破确认后关注 OI 是否配合突破 33.5亿；双重确认 → 考虑做多'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-76500-${Date.now()}`;
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
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 2 ? 'active' : 'expired';
  }
};
