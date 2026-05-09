/**
 * OP 资金费率过热警报（非价格）
 * 监控 OP 合约资金费率异常升高，预警多空失衡
 *
 * 来源：alt-report-OP-2026-05-09-0606
 * 报告判断：当前费率 ~0.007%/8h 正常，>0.05% 需关注
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'OP';
const CREATED_DATE = '2026-05-09';
const FUNDING_THRESHOLD = 0.0005; // 0.05% 过热阈值
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: 'OP-资金费率过热预警',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const funding = await api.getOKXFundingRate(COIN);
      const currentRate = funding.fundingRate;
      const triggered = Math.abs(currentRate) >= FUNDING_THRESHOLD;

      const direction = currentRate > 0 ? '多付空' : '空付多';
      console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率 | [进度] ${this.name} | 费率: ${(currentRate*100).toFixed(4)}% | 阈值: ${(FUNDING_THRESHOLD*100).toFixed(2)}% | 方向: ${direction} | 触发: ${triggered} | [来源] alt-report-OP-2026-05-09-0606: "OP当前费率正常~0.007%，但如果大于0.05%需警惕多头过热"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const funding = await api.getOKXFundingRate(COIN);
      const ticker = await api.getOKXTicker(COIN);
      const klines = await api.getOKXKlines(COIN, '15m', 6);

      // 尝试获取更多数据
      let oiData = null, longShortData = null;
      try {
        const url = `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${COIN}&period=1D`;
        const resp = await api.fetch(url);
        oiData = JSON.parse(resp)?.data?.[0] || null;
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker?.price || 0,
        fundingRate: {
          current: funding.fundingRate,
          next: funding.nextFundingRate,
          fundingTime: new Date(funding.fundingTime * 1000).toISOString(),
          nextFundingTime: new Date(funding.nextFundingTime * 1000).toISOString(),
          isLongPay: funding.isLongPay
        },
        priceChange: { '24h': ticker?.change24h || null },
        openInterest: oiData,
        klines15m: klines?.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })) || [],
        alertType: 'OP-资金费率过热',
        significance: `OP 资金费率 ${(funding.fundingRate*100).toFixed(4)}%，超过阈值${(FUNDING_THRESHOLD*100).toFixed(2)}%，多空失衡预警`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-OP-funding-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.altcoin.model;
    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', model,
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[警报触发] OP资金费率过热警报: ${jobName} | 费率: ${(alertData.fundingRate.current*100).toFixed(4)}%`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};
