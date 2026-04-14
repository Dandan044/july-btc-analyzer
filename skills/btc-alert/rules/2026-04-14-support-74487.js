/**
 * 支撑跌破警报 - $74,487黄金分割位
 * 观望状态，监控支撑跌破确认做空信号
 *
 * ========== 当前状态 ==========
 * 无持仓 | 观望等待方向确认
 * 关键支撑: $74,487 ← 本警报监控
 * ==============================
 *
 * 创建原因: 晚间日报分析，价格触及日线61.8%黄金分割位$74,487
 * 多空比从2.14下降至0.77，空头大量入场，若跌破该支撑，做空信号确认
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-14';
const SUPPORT_LEVEL = 74487;
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: '支撑跌破-74487黄金分割位',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[支撑监控] 当前价格: $${ticker.price}, 支撑位: $${SUPPORT_LEVEL}`);
      return ticker.price < SUPPORT_LEVEL;
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
        supportLevel: SUPPORT_LEVEL,
        breakDistance: (SUPPORT_LEVEL - ticker.price).toFixed(0),
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
        alertType: '支撑跌破',
        significance: '价格跌破日线61.8%黄金分割位$74,487，空头压制确认',
        recommendation: '若跌破后无法快速收回，确认做空入场。止损$75,500，止盈$71,500/$70,000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support74487-${Date.now()}`;
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