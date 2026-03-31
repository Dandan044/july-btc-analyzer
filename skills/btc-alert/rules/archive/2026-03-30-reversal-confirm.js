/**
 * 情绪反转确认警报
 * 监控恐慌贪婪指数回升 + 价格突破EMA7阻力
 * 当前FGI=8（极端恐慌），若回升至20+配合价格突破$68,000，可能确认底部反转
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-30';
const FGI_THRESHOLD = 20; // FGI回升至20触发
const PRICE_THRESHOLD = 68000; // 价格突破EMA7附近
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4小时冷却

module.exports = {
  name: '情绪反转确认警报',
  interval: 30 * 60 * 1000, // 30分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const fgi = await api.getFearGreedIndex(1);
      const ticker = await api.getTicker('BTC');
      
      console.log(`[警报检查] FGI: ${fgi?.current}, 价格: ${ticker.price}`);
      
      // 双重确认：FGI回升 + 价格突破
      if (fgi && fgi.current >= FGI_THRESHOLD && ticker.price >= PRICE_THRESHOLD) {
        return true;
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
      const klines = await api.getKlines('BTC', '1d', 5);
      const klines4h = await api.getKlines('BTC', '4h', 8);
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
        fgiHistory: fgi.history,
        dailyKlines: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          longShortRatio: k.longShortRatio
        })),
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerFGI: FGI_THRESHOLD,
        triggerPrice: PRICE_THRESHOLD,
        alertType: '情绪反转确认',
        significance: 'FGI从极端恐慌(8)回升至20以上，且价格突破$68,000(EMA7)，可能确认底部反转信号。需观察成交量是否放大配合。'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-reversal-confirm-${Date.now()}`;
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
    return daysDiff <= 7 ? 'active' : 'expired'; // 有效期7天
  }
};