/**
 * LAYER 资金费率转正警报
 * 当前资金费率多次深度负值（空头主导），如果转正意味着空头逻辑可能受挑战
 * 
 * 来源: alt-report-LAYER-2026-05-13-1845
 * 报告观点: "资金费率多次深度负值（最低-0.0066），空头占据主导"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'LAYER';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000;

// 资金费率阈值：当前多次负值，如果连续2次3H结算为正值值得关注
const POSITIVE_THRESHOLD = 0.0001;  // 资金费率 > 0.0001 即为正值
const MIN_POSITIVE_COUNT = 2;        // 至少2次正值才触发

module.exports = {
  name: 'LAYER-资金费率转正',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,
  positiveCount: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const fundingData = await api.getOKXFundingRate(COIN);
      const recentRates = fundingData.values || [];
      
      // 检查最近几次资金费率是否转正
      const recentPositive = recentRates.slice(0, MIN_POSITIVE_COUNT).filter(r => r > POSITIVE_THRESHOLD);
      const triggered = recentPositive.length >= MIN_POSITIVE_COUNT;

      const lastRate = recentRates[0] || 0;
      const rateStr = recentRates.slice(0, 5).map(r => r.toFixed(6)).join(', ');

      console.log(`[🔍警报检查] [API] OKX获取LAYER资金费率 | [进度] ${this.name} | 最近费率: ${rateStr} | 最近正值数: ${recentPositive.length}/${MIN_POSITIVE_COUNT} | 触发: ${triggered} | [来源] 05-13 LAYER即时分析: "资金费率多次深度负值，如果转正意味着空头逻辑可能受挑战"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const oiData = await api.getOKXOpenInterest(COIN);
      const fundingData = await api.getOKXFundingRate(COIN);
      const klines = await api.getOKXKlines(COIN, '1h', 6, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        fundingRate: fundingData.values?.slice(0, 5),
        openInterest: oiData.currentOI,
        klines1h: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: '资金费率转正',
        message: `LAYER资金费率转正，空头主导逻辑可能受挑战，需重新评估做空持仓`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-LAYER-funding-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add', '--agent', 'july', '--session', 'isolated',
      '--at', now, '--message', message, '--name', jobName,
      '--delete-after-run', '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[LAYER资金费率警报触发] 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};