/**
 * 止损保护警报 - $72,000（保本位）
 * 多仓持仓中，监控止损位触发
 *
 * ========== 持仓状态 ==========
 * 入场: $72,000 | 1x 全仓多仓
 * 当前: $74,439 (+3.45%)
 * 止损: $72,000 ← 本警报监控（保本位）
 * ==============================
 *
 * 创建原因: 早间日报+即时分析双重建议止损上移至$72,000
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-14';
const TARGET_PRICE = 72000;
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: '止损保护-72000（保本位）',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[止损监控] 当前价格: $${ticker.price}, 保本止损位: $${TARGET_PRICE}`);
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

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        entryPrice: 72000,
        pnl: ((ticker.price - 72000) / 72000 * 100).toFixed(2) + '%',
        triggerPrice: TARGET_PRICE,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '保本止损触发',
        significance: '价格触及保本止损位$72,000，建议立即平仓保护本金',
        recommendation: '触发保本止损，建议立即平仓止损，避免盈利变亏损'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-sl72000-${Date.now()}`;
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
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};