/**
 * 多空比跌破警报 - 散户多空比低于2.0
 * 监控散户多头信心崩溃信号
 * 若触发，可能预示加速下跌
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-30';
const TARGET_RATIO = 2.0; // 多空比阈值
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4小时冷却

module.exports = {
  name: '多空比跌破警报-2.0',
  interval: 30 * 60 * 1000, // 30分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines('BTC', '1d', 1);
      const latest = klines[klines.length - 1];
      
      if (latest && latest.longShortRatio) {
        console.log(`[警报检查] 当前多空比: ${latest.longShortRatio}, 阈值: ${TARGET_RATIO}`);
        return latest.longShortRatio < TARGET_RATIO;
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

      // 提取多空比历史趋势
      const ratioHistory = klines.map(k => ({
        date: k.datetime,
        ratio: k.longShortRatio
      }));

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
        longShortRatio: ratioHistory[0]?.ratio,
        ratioHistory,
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerRatio: TARGET_RATIO,
        alertType: '多空比跌破',
        significance: '散户多空比跌破2.0，多头信心崩溃信号。过去3日多空比从2.73下降至2.14，若跌破2.0可能预示散户认赔完成，加速下跌风险增加。需观察大户动向。'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-ratio-below-2-${Date.now()}`;
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
    return daysDiff <= 5 ? 'active' : 'expired'; // 有效期5天
  }
};