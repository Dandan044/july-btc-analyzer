/**
 * 多空比背离警报
 * 监控 OKX 多空比与Taker买卖比发生方向背离
 * 
 * 报告依据：多空比=0.91（账户层面偏空），但Taker=1.30（成交层面强势买方）。
 * 两者背离暴露"大户在做空，散户在追多"的结构。
 * 当多空比 < 0.95 同时 Taker > 1.2 时，视为背离信号。
 * 
 * 触发条件：多空比 < 0.95 且 Taker > 1.2（双重确认背离）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const LSR_THRESHOLD = 0.95; // 多空比低于此值视为偏空
const TAKER_THRESHOLD = 1.2; // Taker高于此值视为强势买方
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '多空比背离警报',
  interval: 15 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const lsrData = await api.getOKXLongShortRatio();
      const takerData = await api.getOKXTakerRatio();
      
      const lsr = lsrData.currentRatio;
      const taker = takerData.currentRatio;
      
      console.log(`[警报检查] 多空比: ${lsr}, Taker: ${taker}`);
      
      // 背离条件：多空比偏空 + Taker强势买方
      return lsr < LSR_THRESHOLD && taker > TAKER_THRESHOLD;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1h', 6);
      const lsrData = await api.getOKXLongShortRatio();
      const takerData = await api.getOKXTakerRatio();
      const oiData = await api.getOKXOpenInterest();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        longShortRatio: {
          current: lsrData.currentRatio,
          buyVolume: lsrData.buyVolume,
          sellVolume: lsrData.sellVolume,
          threshold: LSR_THRESHOLD
        },
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume,
          threshold: TAKER_THRESHOLD
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '多空比背离',
        significance: `多空比=${lsrData.currentRatio}（偏空）+ Taker=${takerData.currentRatio}（强势买方）背离，
大户在做空，散户在追多 → 下跌概率高`,
        recommendation: '背离信号出现后，若价格跌破 $75,550 支撑，确认下跌趋势，可关注做空机会'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-lsr-taker-divergence-${Date.now()}`;
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
    return daysDiff <= 2 ? 'active' : 'expired';
  }
};
