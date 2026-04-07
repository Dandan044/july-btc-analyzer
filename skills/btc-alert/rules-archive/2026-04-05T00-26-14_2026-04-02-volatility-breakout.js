/**
 * 波动率突破警报
 * 监控 BTC 近期振幅突破，预示方向选择
 * 
 * 背景：4月2日振幅仅$625.8（0.9%），近期最低。低波动蓄势后若突然放大，
 * 往往预示方向选择和突破。持仓等待$70,000止盈，波动率突破可作为辅助信号。
 * 
 * 修正：使用近4小时的K线计算振幅，避免24小时数据导致的重复触发问题
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-02';
const TARGET_VOLATILITY = 1.5; // 近4小时振幅超过1.5%触发（时间窗口缩短，阈值降低）
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却
const WINDOW_HOURS = 4; // 监控最近4小时

module.exports = {
  name: '波动率突破警报',
  interval: 30 * 60 * 1000, // 30分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取近4小时的1小时K线数据
      const klines = await api.getKlines('BTC', '1h', WINDOW_HOURS);
      
      // 计算时间窗口内的最高价和最低价
      let windowHigh = -Infinity;
      let windowLow = Infinity;
      
      for (const k of klines) {
        if (k.high > windowHigh) windowHigh = k.high;
        if (k.low < windowLow) windowLow = k.low;
      }
      
      // 计算振幅百分比
      const volatility = ((windowHigh - windowLow) / windowLow) * 100;
      
      console.log(`[波动率检查] 近${WINDOW_HOURS}小时振幅: ${volatility.toFixed(2)}% (高: ${windowHigh}, 低: ${windowLow}), 目标: ${TARGET_VOLATILITY}%`);
      return volatility >= TARGET_VOLATILITY;
    } catch (error) {
      console.error('[波动率检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines4h = await api.getKlines('BTC', '1h', WINDOW_HOURS);
      const klinesDaily = await api.getKlines('BTC', '4h', 7);
      const fgi = await api.getFearGreedIndex(7);

      // 计算近4小时振幅
      let windowHigh = -Infinity;
      let windowLow = Infinity;
      for (const k of klines4h) {
        if (k.high > windowHigh) windowHigh = k.high;
        if (k.low < windowLow) windowLow = k.low;
      }
      const volatility = ((windowHigh - windowLow) / windowLow) * 100;

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        volatilityWindow: `${WINDOW_HOURS}h`,
        volatilityPercent: volatility.toFixed(2),
        windowHigh: windowHigh,
        windowLow: windowLow,
        high24h: ticker.high24h,
        low24h: ticker.low24h,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': ticker.change7d
        },
        volume24h: ticker.volume24h,
        fearGreedIndex: fgi.current,
        klines1h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        klines4h: klinesDaily.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerThreshold: TARGET_VOLATILITY,
        alertType: '波动率突破',
        significance: `近${WINDOW_HOURS}小时振幅突破${TARGET_VOLATILITY}%，预示方向选择。持仓等待$70,000止盈，若向上突破则止盈概率增加。`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-volatility-${Date.now()}`;
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
    // 波动率警报有效期2天（持仓等待止盈期间）
    return daysDiff <= 2 ? 'active' : 'expired';
  }
};