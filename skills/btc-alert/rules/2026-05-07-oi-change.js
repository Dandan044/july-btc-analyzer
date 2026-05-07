/**
 * 持仓量异动警报
 * 监控 BTC 合约持仓量24小时变化超过阈值（绝对值 > 5%）
 * OI 大幅变化可能预示趋势动能转变或仓位集中
 *
 * 来源：active/cycle-20260507-001/reports/btc-report-2026-05-07-0900.md
 * 报告观点：OI从峰值3,710k降至3,583k(-3.4%)，价格冲高回落+OI下降=多空均有离场。
 *   若OI继续大幅变化，需关注趋势动能是否进一步减弱。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'BTC';  // ← BTC 使用 trigger.btc.model

const CREATED_DATE = '2026-05-07';
const OI_CHANGE_THRESHOLD = 5; // 24h OI 变化绝对值 > 5%
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却（OI不是高频数据）

module.exports = {
  name: '持仓量异动警报',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      const change24h = Math.abs(oiData.change24h);
      const triggered = change24h >= OI_CHANGE_THRESHOLD;
      const direction = oiData.change24h >= 0 ? '增' : '减';

      console.log(`[🔍警报检查] [API] OKX获取BTC持仓量数据 | [进度] ${this.name} | 当前OI: ${(oiData.currentOI/10000).toFixed(0)}万BTC | 24h变化: ${oiData.change24h.toFixed(1)}%(${direction}) | 阈值: ±${OI_CHANGE_THRESHOLD}% | 触发: ${triggered} | [来源] 05-07 09:00日报: "OI从峰值回落，需关注趋势动能变化"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const oiData = await api.getOKXOpenInterest();
      const ticker = await api.getTicker('BTC');
      const klines15m = await api.getKlines('BTC', '15m', 8);
      
      let takerData = null;
      try {
        takerData = await api.getOKXTakerRatio();
      } catch (e) { /* 静默 */ }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        openInterest: {
          current: oiData.currentOI,
          previous: oiData.prevOI,
          change24hPercent: oiData.change24h,
          direction: oiData.change24h >= 0 ? '增加' : '减少',
          timestamp: oiData.timestamp
        },
        
        takerBuyRatio: takerData?.currentRatio,
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        alertType: '持仓量异动',
        significance: `OI 24h变化 ${Math.abs(oiData.change24h).toFixed(1)}%(${oiData.change24h >= 0 ? '增' : '减'})，超过阈值${OI_CHANGE_THRESHOLD}%，需评估对趋势动能的影响`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/instant-analysis-stage1.md 执行数据获取\n2. 读取 tasks/daily-report-stage2.md 执行技术分析\n3. 读取 tasks/daily-report-stage3.md 执行仓位管理\n4. 读取 tasks/daily-report-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    // 模型从 global-config.json 读取：BTC → trigger.btc.model (pro)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', model,  // ← 来自 tasks/global-config.json trigger.btc.model
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[警报触发] 已派发即时分析全四阶段任务: ${jobName} | OI变化: ${data.openInterest.change24hPercent.toFixed(1)}%`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
