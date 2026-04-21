/**
 * 阻力位突破警报
 * 监控 BTC 价格突破 $76,500
 * 
 * 报告依据：$76,500 是即时阻力位（整数关口），突破后上看 $77,740。
 * 突破条件：4H 收盘站稳 $76,500 + OI 突破 33.5亿（双重确认）。
 * 
 * ========== 当前状态 ==========
 * 当前价格: $76,040
 * 目标阻力: $76,500（上方 $460）
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const TARGET_PRICE = 76500;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '阻力位突破警报-76500',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: $${ticker.price}, 目标阻力: $${TARGET_PRICE}`);
      return ticker.price >= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '4h', 4);
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
          change24h: oiData.change24h,
          threshold: 3350000000 // 33.5亿美元 = 33.5亿OI
        },
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume
        },
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerPrice: TARGET_PRICE,
        alertType: '阻力位突破',
        significance: `价格突破 $76,500 阻力位，4H 结构可能转多，需关注 OI 是否配合突破 33.5亿`,
        recommendation: '若 OI 同步突破 33.5亿 → 考虑分批做多；若 OI 未配合 → 可能是假突破，保持观望'
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
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 2 ? 'active' : 'expired'; // 有效期2天
  }
};
