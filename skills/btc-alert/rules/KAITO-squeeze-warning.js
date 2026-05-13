/**
 * KAITO 空头挤压预警警报
 * 当OI快速增加+Taker买入比飙升时触发，预警空头挤压风险
 *
 * 来源：alt-report-KAITO-2026-05-13-1050.md
 * 报告观点：做空持仓，需警惕超卖反弹导致的空头挤压
 * 持仓：做空65张 KAITO-USDT-SWAP @ $0.4606
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-13';
const COIN = 'KAITO';
const OI_INCREASE_THRESHOLD = 0.15;  // OI增加15%以上
const TAKER_BUY_THRESHOLD = 1.8;     // Taker买入比 > 1.8（空头挤压信号）
const COOLDOWN_MS = 60 * 60 * 1000;

const BASELINE_OI = 2100000;  // 当前OI基准约2.1M

module.exports = {
  name: 'KAITO-空头挤压预警',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      const takerData = await api.getOKXTakerRatio(COIN);

      const currentOI = oiData?.currentOI || 0;
      const currentTaker = takerData?.currentRatio || 0;

      const oiIncrease = (currentOI - BASELINE_OI) / BASELINE_OI;
      const oiMet = oiIncrease >= OI_INCREASE_THRESHOLD;
      const takerMet = currentTaker >= TAKER_BUY_THRESHOLD;
      const triggered = oiMet && takerMet;

      console.log(`[🔍警报检查] [API] OKX获取${COIN} OI+Taker数据 | [进度] ${this.name} | OI: ${currentOI.toFixed(0)}(基准:${BASELINE_OI}, 增幅:${(oiIncrease*100).toFixed(1)}%, 阈值:${OI_INCREASE_THRESHOLD*100}%) ${oiMet?'✅':'❌'} | Taker比: ${currentTaker.toFixed(2)}(阈值:${TAKER_BUY_THRESHOLD}) ${takerMet?'✅':'❌'} | 触发: ${triggered} | [来源] 05-13 10:50山寨报告: "做空持仓，警惕超卖反弹导致空头挤压"`);

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
      const takerData = await api.getOKXTakerRatio(COIN);
      const klines = await api.getOKXKlines(COIN, '15m', 8, 'SWAP');

      const currentOI = oiData?.currentOI || 0;
      const oiIncrease = ((currentOI - BASELINE_OI) / BASELINE_OI * 100).toFixed(1);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        openInterest: currentOI,
        oiIncrease: oiIncrease + '%',
        takerBuyRatio: takerData?.currentRatio,
        klines15m: klines.map(k => ({
          time: k.time || k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: '空头挤压预警',
        significance: `OI增至${currentOI.toFixed(0)}(+${oiIncrease}%)且Taker买入比${takerData?.currentRatio?.toFixed(2)}(>1.8)，空头挤压风险上升`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-squeeze-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${COIN}警报触发] 空头挤压预警: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};
