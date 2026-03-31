/**
 * 散户多空比极端警报
 * 监控散户多空比异常变化
 * 当前多空比2.16处于极端高位，若继续攀升可能预示多头陷阱
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-27';
const RATIO_THRESHOLD = 2.5; // 多空比超过2.5触发
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '散户多空比极端警报',
  interval: 15 * 60 * 1000, // 15分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines('BTC', '1d', 1);
      const latestKline = klines[0];

      if (latestKline && latestKline.longShortRatio) {
        const ratio = latestKline.longShortRatio;
        console.log(`[警报检查] 当前散户多空比: ${ratio.toFixed(2)}, 阈值: ${RATIO_THRESHOLD}`);
        return ratio >= RATIO_THRESHOLD;
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
        dailyKlines: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          longShortRatio: k.longShortRatio
        })),
        triggerRatio: RATIO_THRESHOLD,
        alertType: '多空比极端',
        significance: '散户多空比超过2.5，散户极度看多，而大户保持中立。历史经验显示这是空头信号，当前做空建议可能需要加仓。'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-longshort-extreme-${Date.now()}`;
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