/**
 * 支撑位坚守警报 - $78,000
 * 触发条件：BTC 价格回踩 $78,000 并缩量企稳（关键心理关口）
 * 触发后：执行即时分析，评估是否做多
 * 
 * 依据：04-22 21:00日报判断"$78,000 是即时支撑和心理关口，
 *       若回踩 $78,000 缩量（4H成交量低于 $500M）企稳，
 *       longShortRatio维持0.70以下，是做多信号A（回踩入场）"。
 *       当前价格 $78,163，距 $78,000 仅$163（0.21%），是最接近的下方支撑。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const TARGET_PRICE = 78000;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '支撑位坚守警报-78000',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      const ticker = await api.getTicker('BTC');
      // 价格触及 $78,000 或更低视为触发
      const triggered = ticker.price <= TARGET_PRICE && ticker.price > 77500;
      console.log(`[警报检查] ${this.name} | 当前价: $${ticker.price} | 目标: $${TARGET_PRICE} | 触发: ${triggered}`);
      return triggered;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines4h = await api.getKlines('BTC', '4h', 5);
      const klines1h = await api.getKlines('BTC', '1h', 6);
      const priceHistory = await api.getPriceHistory('BTC', 7);
      
      // 计算4H成交量均值（用于判断是否缩量）
      const avg4hVolume = klines4h.slice(0, 4).reduce((sum, k) => sum + k.volume, 0) / 4;
      const latest4hVolume = klines4h[0]?.volume || 0;
      const volumeRatio = latest4hVolume / avg4hVolume;
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': priceHistory.prices.length > 0 
            ? ((ticker.price - priceHistory.prices[priceHistory.prices.length - 1]) / priceHistory.prices[priceHistory.prices.length - 1] * 100).toFixed(2)
            : null
        },
        volume24h: ticker.volume24h,
        triggerPrice: TARGET_PRICE,
        latest4hVolume: latest4hVolume,
        avg4hVolume: avg4hVolume,
        volumeRatio: volumeRatio.toFixed(2),
        isShrinking: volumeRatio < 0.5 ? '是（极度缩量）' : volumeRatio < 0.8 ? '是（缩量）' : '否（放量）',
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        klines1h: klines1h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '支撑位坚守（下方价格）',
        significance: `价格回踩 $${TARGET_PRICE} 且缩量（4H成交量${(volumeRatio * 100).toFixed(0)}%均值）。${volumeRatio < 0.8 ? '缩量说明抛压不重，若longShortRatio维持0.70以下，是做多信号A（回踩入场）' : '成交量仍较高，需观察能否企稳'}。止损 $76,800（-1.54%），止盈 $78,420（+0.54%）→ $79,000（+1.28%）。`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-78000-${Date.now()}`;
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

    console.log(`[警报触发] ${this.name} | 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};