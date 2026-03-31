/**
 * 散户多空比极端警报 - 阈值2.5
 * 监控散户多空比回升至极端水平
 * 当前多空比已从峰值2.73回落至2.39
 * 若回升至2.5+需警惕新一轮抄底潮
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-29';
const LS_THRESHOLD = 2.5; // 多空比回升至2.5触发
const COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6小时冷却

module.exports = {
  name: '散户多空比回升警报-2.5',
  interval: 30 * 60 * 1000, // 30分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 使用4小时K线获取最新多空比
      const klines = await api.getKlines('BTC', '4h', 1);
      if (klines && klines.length > 0 && klines[0].longShortRatio) {
        const ratio = klines[0].longShortRatio;
        console.log(`[警报检查] 当前散户多空比: ${ratio.toFixed(2)}, 阈值: ${LS_THRESHOLD}`);
        return ratio >= LS_THRESHOLD;
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
      const klines4h = await api.getKlines('BTC', '4h', 6);
      const fgi = await api.getFearGreedIndex(7);

      // 获取多空比历史趋势
      const lsHistory = klines4h.map(k => ({
        time: k.datetime,
        longShortRatio: k.longShortRatio,
        topTraderRatio: k.topTraderRatio
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
        longShortRatioHistory: lsHistory,
        currentLongShortRatio: lsHistory[0]?.longShortRatio || 0,
        triggerThreshold: LS_THRESHOLD,
        alertType: '散户多空比回升',
        significance: '散户多空比回升至2.5+，散户抄底情绪重新升温。需结合大户动向判断是否为新一轮抄底或行情反转信号。当前FGI=9极度恐慌，若多空比回升可能是底部确认信号。'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-longshort-rebound-${Date.now()}`;
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