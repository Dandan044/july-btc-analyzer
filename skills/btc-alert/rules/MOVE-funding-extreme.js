const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'MOVE';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// 资金费率极端警报
// 近期出现过 -0.94% 的极端负费率（空头过度拥挤）
// 若再次触及 ≤ -0.5% 或 ≥ 0.1%（多头过度拥挤），触发警报
const FR_EXTREME_NEG = -0.005; // -0.5%
const FR_EXTREME_POS = 0.001;  // 0.1%

module.exports = {
  name: 'MOVE-资金费率极端',
  interval: 5 * 60 * 1000, // 5分钟
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const fr = await api.getOKXFundingRate(COIN);
      if (!fr || fr.fundingRate === undefined || fr.fundingRate === null) return false;

      const currentFR = fr.fundingRate;
      const triggered = currentFR <= FR_EXTREME_NEG || currentFR >= FR_EXTREME_POS;
      const direction = currentFR <= FR_EXTREME_NEG ? '空头过度拥挤' : currentFR >= FR_EXTREME_POS ? '多头过度拥挤' : '正常';

      console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率 | [进度] ${this.name} | 当前费率: ${(currentFR * 100).toFixed(4)}% | 阈值: ≤${(FR_EXTREME_NEG * 100).toFixed(1)}% 或 ≥${(FR_EXTREME_POS * 100).toFixed(1)}% | 状态: ${direction} | 触发: ${triggered} | [来源] 05-12 MOVE山寨分析: "近期出现-0.94%极端负费率，空头过度拥挤后可能轧空反弹"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const fr = await api.getOKXFundingRate(COIN);
      const oi = await api.getOKXOpenInterest(COIN);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: 'funding-rate-extreme',
        currentPrice: ticker.price,
        fundingRate: fr.fundingRate,
        fundingRatePct: (fr.fundingRate * 100).toFixed(4) + '%',
        direction: fr.fundingRate <= FR_EXTREME_NEG ? 'short_crowded' : 'long_crowded',
        openInterest: oi.currentOI
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-MOVE-fr-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}
以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理`;

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

    this.lastTriggered = Date.now();
    console.log(`[🔔警报触发] ${this.name} | 资金费率: ${data.fundingRatePct} | 方向: ${data.direction} | 当前价: $${data.currentPrice}`);
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