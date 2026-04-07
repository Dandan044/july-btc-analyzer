/**
 * 资金费率转负警报
 * 监控资金费率从正转负，预示做多情绪消退
 * 来源：btc-report-2026-03-31-0940
 * 当前资金费率 0.0001%，若转负说明反弹可能失败
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-31';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

module.exports = {
  name: '资金费率转负警报',
  interval: 10 * 60 * 1000, // 10分钟检查
  lastTriggered: 0,
  lastFundingRate: 0.0001, // 记录上次费率

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines('BTC', '1d', 1);
      const latest = klines[0];
      const fundingRate = latest?.fundingRate || 0;

      console.log(`[警报检查] 当前资金费率: ${fundingRate.toFixed(6)}, 上次: ${this.lastFundingRate.toFixed(6)}`);

      // 资金费率从正转负
      if (this.lastFundingRate > 0 && fundingRate < 0) {
        this.lastFundingRate = fundingRate;
        return true;
      }

      this.lastFundingRate = fundingRate;
      return false;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1d', 7);
      const fgi = await api.getFearGreedIndex(7);

      // 获取历史资金费率趋势
      const fundingRates = klines.map(k => ({
        date: k.datetime,
        rate: k.fundingRate || 0
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
        fundingRates: fundingRates,
        alertType: '资金费率转负',
        significance: '资金费率从正转负，做多情绪消退。反弹可能失败，需关注价格是否回踩支撑位。当前建议做多持仓，此信号为风险预警。'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-funding-negative-${Date.now()}`;
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
    // 7天后自动过期
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};