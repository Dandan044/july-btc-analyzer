/**
 * JUP OI回升 + Taker买卖比确认监控警报
 * 
 * 来源: alt-report-JUP-2026-05-12-2222.md
 * 报告观点: 做多入场条件之一：OI回升至$800K+ + Taker买卖比>1.2持续2个周期。
 *           当前OI $775K（下降9%），Taker比1.05（不稳定）。
 *           当这两个条件同时满足，确认做多入场信号。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'JUP';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// OI 回升阈值：高于此值视为杠杆资金回流
const OI_RECOVERY_THRESHOLD = 800000; // $800K
// Taker 买卖比阈值：高于此值视为买方力量确认
const TAKER_BUY_THRESHOLD = 1.2;

module.exports = {
  name: 'JUP-OI回升与Taker买方确认',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,

  // ⭐ 连续确认计数器（需要连续2个周期满足条件）
  consecutiveCount: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      const currentOI = oiData?.currentOIValue || oiData?.currentOI || 0;
      
      const takerData = await api.getOKXTakerRatio(COIN);
      const currentTakerRatio = takerData?.currentRatio || takerData?.ratio || 0;

      const oiRecovered = currentOI >= OI_RECOVERY_THRESHOLD;
      const takerConfirmed = currentTakerRatio >= TAKER_BUY_THRESHOLD;
      const bothMet = oiRecovered && takerConfirmed;

      // ⭐ 连续确认逻辑
      if (bothMet) {
        this.consecutiveCount++;
      } else {
        this.consecutiveCount = 0;
      }

      const triggered = this.consecutiveCount >= 2;

      console.log(`[🔍警报检查] [API] OKX获取${COIN} OI和Taker买卖比 | [进度] ${this.name} | OI: $${(currentOI/1000).toFixed(1)}K (回升阈值: $${OI_RECOVERY_THRESHOLD/1000}K, ${oiRecovered?'✅':'❌'}) | Taker比: ${currentTakerRatio.toFixed(2)} (买方阈值: ${TAKER_BUY_THRESHOLD}, ${takerConfirmed?'✅':'❌'}) | 连续确认: ${this.consecutiveCount}/2 | 触发: ${triggered} | [来源] 05-12 JUP即时分析: "做多条件：OI回升$800K+ + Taker>1.2持续2个周期"`);

      if (triggered) {
        this._lastCheckData = { currentOI, currentTakerRatio, oiRecovered, takerConfirmed, consecutiveCount: this.consecutiveCount };
      }

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const checkData = this._lastCheckData || {};
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines1h = await api.getOKXKlines(COIN, '1h', 6, 'SWAP');
      
      let lsData = null, fundingData = null;
      try {
        lsData = await api.getOKXLongShortRatio(COIN);
        fundingData = await api.getOKXFundingRate(COIN);
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker?.price,
        
        oiStatus: {
          current: checkData.currentOI,
          threshold: OI_RECOVERY_THRESHOLD,
          recovered: checkData.oiRecovered,
          signal: checkData.oiRecovered ? 'OI回升至$800K以上，杠杆资金回流' : 'OI未回升'
        },
        
        takerStatus: {
          current: checkData.currentTakerRatio,
          threshold: TAKER_BUY_THRESHOLD,
          confirmed: checkData.takerConfirmed,
          consecutiveCount: checkData.consecutiveCount,
          signal: checkData.takerConfirmed ? `Taker买卖比>1.2连续${checkData.consecutiveCount}个周期，买方力量确认` : 'Taker比未达标'
        },
        
        longShortRatio: lsData,
        fundingRate: fundingData,
        klines1h: klines1h.map(k => ({
          time: k.time || k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        alertType: 'OI回升+Taker买方确认',
        significance: 'OI回升至$800K+ 且 Taker买卖比>1.2连续2个周期，做多入场条件满足'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-oi-taker-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[${COIN}警报触发] 已派发即时分析任务: ${jobName} | OI回升: ${alertData.oiStatus?.recovered} | Taker确认: ${alertData.takerStatus?.confirmed}`);
    this.lastTriggered = Date.now();
    this._lastCheckData = null;
    this.consecutiveCount = 0;
  },

  lifetime() {
    // ⭐ 触发后即归档
    if (this.lastTriggered > 0) return 'completed';

    // 保底：超过 3 天未触发也归档
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};