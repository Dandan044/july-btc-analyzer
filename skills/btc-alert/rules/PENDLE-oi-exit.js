/**
 * PENDLE OI资金离场监控警报
 * 
 * 来源：alt-PENDLE-20260511-1706/reports/alt-report-PENDLE-2026-05-12-0643.md
 * 报告观点：OI 268万仍高于基线214万，仍有空头燃料。如果OI降至200万以下，
 *          说明资金离场，趋势结构受损，应放弃做多。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'PENDLE';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const OI_THRESHOLD = 2000000; // 200万张以下触发

module.exports = {
  name: 'PENDLE-OI资金离场',
  interval: 10 * 60 * 1000, // 10分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      const currentOI = oiData.currentOI;
      
      console.log(`[🔍警报检查] [API] OKX获取${COIN} OI | [进度] ${this.name} | 当前OI: ${currentOI?.toFixed(0)} | 阈值: ${OI_THRESHOLD} | 触发: ${currentOI < OI_THRESHOLD} | [来源] 05-12 06:43即时分析: "OI降至200万以下→资金离场，趋势结构受损，放弃做多"`);
      
      return currentOI < OI_THRESHOLD;
    } catch (error) {
      console.error('[❌PENDLE OI警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    const ticker = await api.getOKXTicker(COIN, 'SWAP');
    const oiData = await api.getOKXOpenInterest(COIN);
    const klines4h = await api.getOKXKlines(COIN, '4H', 3, 'SWAP');
    
    let takerData = null;
    try {
      takerData = await api.getOKXTakerRatio(COIN);
    } catch (e) { /* 静默 */ }

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      currentPrice: ticker.price,
      triggerCondition: 'OI < 200万',
      currentOI: oiData.currentOI,
      oiThreshold: OI_THRESHOLD,
      priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
      takerBuyRatio: takerData?.currentRatio,
      klines4h: klines4h.map(k => ({
        time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
      })),
      alertType: 'OI资金离场',
      significance: `OI降至${oiData.currentOI?.toFixed(0)}张（阈值200万），资金离场信号，趋势结构可能受损`
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

    console.log(`[PENDLE警报触发] 已派发即时分析任务: ${jobName} | OI资金离场`);
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