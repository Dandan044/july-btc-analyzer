const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'LDO';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const FUNDING_THRESHOLD = 0.001; // 0.1% = extreme

module.exports = {
  name: 'LDO-funding-extreme',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const data = await api.fetch('https://www.okx.com/api/v5/public/funding-rate?instId=LDO-USDT-SWAP');
      if (!data || !data.data || data.data.length === 0) return false;

      const fr = parseFloat(data.data[0].fundingRate);
      return Math.abs(fr) >= FUNDING_THRESHOLD;
    } catch (error) {
      console.error('[LDO资金费率警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    const ticker = await api.getOKXTicker(COIN);
    const frData = await api.fetch('https://www.okx.com/api/v5/public/funding-rate?instId=LDO-USDT-SWAP');
    const fr = frData?.data?.[0];

    return {
      coin: COIN,
      currentPrice: ticker.price,
      change24h: ticker.change24h,
      fundingRate: fr?.fundingRate,
      nextFundingTime: fr?.nextFundingTime,
      settledFundingRate: fr?.settFundingRate,
      threshold: FUNDING_THRESHOLD,
    };
  },

  trigger(alert) {
    this.lastTriggered = Date.now();
    const fr = alert.data.fundingRate;
    const dir = parseFloat(fr) > 0 ? '多头付费→空头' : '空头付费→多头';
    console.log(`[LDO资金费率警报] 费率: ${fr} (${dir}) | 价格: ${alert.data.currentPrice}`);

    const child = spawn('node', [
      '-e',
      `const {execSync} = require('child_process');
       const data = ${JSON.stringify(alert.data)};
       const msg = "[SPAWN_INSTANT_ANALYSIS]" + JSON.stringify(data) + "\\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理";
       execSync("openclaw sessions spawn --agent july --mode run --task " + JSON.stringify(msg), {stdio: 'inherit'});`
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  },

  lifetime() {
    const ageHours = (Date.now() - new Date(CREATED_DATE).getTime()) / (1000 * 60 * 60);
    return ageHours < 72 ? 'active' : 'expired';
  }
};