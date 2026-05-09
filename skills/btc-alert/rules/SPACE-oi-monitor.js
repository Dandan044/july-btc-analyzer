/**
 * SPACE 持仓量(OI)监控警报
 * 监控OI变化：若OI跌破2.2M SPACE，触发即时分析（资金撤退信号）
 *
 * 来源：alt-report-SPACE-2026-05-08-1754
 * 报告观点："OI跌破2.2M → 资金撤退，看空"
 * 当前OI：~2.65M SPACE（OKX rubik/stat）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'SPACE';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000;
const OI_THRESHOLD = 2200000; // 2.2M SPACE tokens

module.exports = {
  name: 'SPACE持仓量萎缩警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  lastKnownOI: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      const latestOI = oiData.currentOI;
      this.lastKnownOI = latestOI;

      const triggered = latestOI < OI_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取SPACE持仓量(rubik/stat) | [进度] ${this.name} | 当前OI: ${(latestOI/1000000).toFixed(2)}M SPACE | 阈值: ${(OI_THRESHOLD/1000000).toFixed(2)}M SPACE | 触发: ${triggered} | [来源] 05-08 SPACE即时分析: "OI跌破2.2M=资金撤退，看空信号"`);

      return triggered;
    } catch (error) {
      console.error(`[❌SPACE OI检查错误]`, error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      const ticker = await api.getOKXTicker(COIN, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: 'OI_drop',
        currentPrice: ticker.price,
        openInterest: oiData.currentOI,
        oiChange24h: oiData.change24h,
        oiThreshold: OI_THRESHOLD,
        significance: `SPACE OI跌破${(OI_THRESHOLD/1000000).toFixed(1)}M，资金撤退信号`
      };
    } catch (error) {
      console.error('[❌SPACE OI数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-SPACE-oi-${Date.now()}`;
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

    console.log(`[SPACE OI警报触发] 已派发即时分析: ${jobName} | OI: ${data.openInterest} (阈值: ${OI_THRESHOLD})`);

    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 4 ? 'active' : 'expired';
  }
};
