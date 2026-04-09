/**
 * 做多入场条件警报 - $71,000支撑区
 * 来源：btc-report-2026-04-08-2100
 * 分析结论：等待回踩至$70,500-$71,000区间入场做多
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-08';
const EXPIRY_DATE = '2026-04-11';
const TARGET_PRICE = 71000;
const COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却（入场机会需快速响应）

module.exports = {
  name: '做多入场条件警报-71000',
  interval: 2 * 60 * 1000, // 2分钟检查一次（入场机会需快速响应）
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 入场触发区: ${TARGET_PRICE}`);
      // 价格回踩至$71,000以下触发入场机会
      return ticker.price <= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 8);
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
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerPrice: TARGET_PRICE,
        alertType: '做多入场条件',
        significance: '价格回踩至$70,500-$71,000支撑区，观察支撑确认后入场做多',
        analysisContext: {
          reportId: 'btc-report-2026-04-08-2100',
          suggestionId: 'sug-001',
          direction: 'long',
          entryZone: [70500, 71000],
          stopLoss: 68000,
          takeProfit1: 73500,
          takeProfit2: 75000,
          recommendation: '确认支撑后入场做多，仓位50%'
        }
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-entry-long-71000-${Date.now()}`;
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
    const expiry = new Date(EXPIRY_DATE);
    const now = new Date();
    if (now < expiry) {
      return 'active';
    }
    return 'expired';
  }
};