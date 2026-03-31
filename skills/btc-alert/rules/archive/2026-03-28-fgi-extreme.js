/**
 * 恐慌贪婪指数极端警报
 * 监控恐慌贪婪指数达到极端值
 * 当前FGI=12，极度恐慌持续第4天
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-28';
const FGI_THRESHOLD = 10; // 恐慌指数低于10触发
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6小时冷却

module.exports = {
  name: '恐慌贪婪指数极端警报',
  interval: 30 * 60 * 1000, // 30分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const fgi = await api.getFearGreedIndex(1);
      if (fgi && fgi.current) {
        const value = fgi.current;
        console.log(`[警报检查] 当前恐慌贪婪指数: ${value}, 阈值: ${FGI_THRESHOLD}`);
        return value <= FGI_THRESHOLD;
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
      const klines = await api.getKlines('BTC', '1d', 3);
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
        triggerFGI: FGI_THRESHOLD,
        alertType: '情绪极端',
        significance: '恐慌贪婪指数低于10，极度恐慌达到极端水平。历史反向指标，可能触发技术性反弹。需结合散户多空比判断是否为真正的底部信号。'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-fgi-extreme-${Date.now()}`;
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
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天
  }
};