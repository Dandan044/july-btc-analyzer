/**
 * Taker 买卖比爆发警报
 * 监控 BTC Taker 买卖比突破 2.0（买方力量极度爆发）
 * 
 * 报告依据：04-21 08:00 Taker Ratio = 1.55（当日最高），配合价格上涨。
 * Taker Ratio > 2.0 代表主动买入力量是主动卖出力量的2倍以上，
 * 是极为强烈的买方信号，往往预示价格将快速拉升。
 * 
 * 注意：OKX Taker Ratio 数据为日频更新，但本规则通过 4H K线辅助判断，
 * 若 4H 结构连续出现 Taker > 1.5 配合价格上涨，需高度关注。
 * 
 * ========== 当前状态 ==========
 * Taker Ratio 当前: ~1.55（04-21 08:00）
 * 触发阈值: > 2.0（极度买方主导）
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const TAKER_THRESHOLD = 2.0; // 触发阈值：Taker Ratio > 2.0
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'Taker买卖比爆发警报',
  interval: 15 * 60 * 1000, // 15分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const takerData = await api.getOKXTakerRatio();
      console.log(`[警报检查] Taker Ratio: ${takerData.currentRatio}, 阈值: ${TAKER_THRESHOLD}`);
      return takerData.currentRatio > TAKER_THRESHOLD;
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
          change24h: oiData.change24h
        },
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume,
          threshold: TAKER_THRESHOLD,
          change: takerData.change
        },
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: 'Taker买卖比爆发',
        significance: `Taker Ratio > 2.0，买方力量是卖方的2倍以上，极度强势信号`,
        recommendation: 'Taker Ratio 爆发通常预示价格快速拉升；若同时 OI 配合上升 → 确认趋势，可关注做多机会'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-taker-ratio-2-${Date.now()}`;
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
