/**
 * PENDLE 日线Taker买卖比回落监控警报
 * 
 * 来源：alt-PENDLE-20260511-1706/reports/alt-report-PENDLE-2026-05-12-0643.md
 * 报告观点：日线Taker买卖比1.044（偏多）是中长期买方承接信号。如果Taker回落至1.0以下，
 *          说明主动买入消退，偏多信号失效，应重新评估做多逻辑。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'PENDLE';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const TAKER_THRESHOLD = 1.0; // 日线Taker买卖比回落至1.0以下触发

module.exports = {
  name: 'PENDLE-Taker买入消退',
  interval: 10 * 60 * 1000, // 10分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const takerData = await api.getOKXTakerRatio(COIN);
      const currentRatio = takerData.currentRatio;
      
      console.log(`[🔍警报检查] [API] OKX获取${COIN} Taker比 | [进度] ${this.name} | 当前Taker: ${currentRatio?.toFixed(3)} | 阈值: ${TAKER_THRESHOLD} | 触发: ${currentRatio < TAKER_THRESHOLD} | [来源] 05-12 06:43即时分析: "日线Taker回落至1.0以下→主动买入消退，偏多信号失效"`);
      
      return currentRatio < TAKER_THRESHOLD;
    } catch (error) {
      console.error('[❌PENDLE Taker警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    const ticker = await api.getOKXTicker(COIN, 'SWAP');
    const takerData = await api.getOKXTakerRatio(COIN);
    const klines4h = await api.getOKXKlines(COIN, '4H', 3, 'SWAP');
    
    let oiData = null;
    try {
      oiData = await api.getOKXOpenInterest(COIN);
    } catch (e) { /* 静默 */ }

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      currentPrice: ticker.price,
      triggerCondition: '日线Taker买卖比 < 1.0',
      currentTakerRatio: takerData.currentRatio,
      takerThreshold: TAKER_THRESHOLD,
      priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
      openInterest: oiData?.currentOI,
      klines4h: klines4h.map(k => ({
        time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
      })),
      alertType: 'Taker买入消退',
      significance: `日线Taker买卖比降至${takerData.currentRatio?.toFixed(3)}（阈值1.0），主动买入消退，偏多信号可能失效`
    };
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-PENDLE-${Date.now()}`;
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

    console.log(`[PENDLE警报触发] 已派发即时分析任务: ${jobName} | Taker买入消退`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    // ⭐ 触发后即归档（引擎自动移动到 rules-archive/，不会删除文件）
    if (this.lastTriggered > 0) return 'completed';

    // 保底：超过 3 天未触发也归档（过期）
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};