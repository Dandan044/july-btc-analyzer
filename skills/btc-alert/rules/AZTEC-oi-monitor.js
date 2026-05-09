/**
 * AZTEC 持仓量增长监控警报
 * 
 * 监控 OI 是否显著增长，作为增量资金进场的先行指标
 * 来源: active/alt-AZTEC-20260508-2104/reports/alt-report-AZTEC-2026-05-08-2104.md
 */

const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');
const api = require('../../btc-market-lite/scripts/api');

const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000;
const COIN = 'AZTEC';

// OI 触发阈值：从 ~824k 增长至 1.2M+ 视为显著增长
// 2026-05-09 02:15 → OI已至1,154K，上调阈值避免重复触发
const OI_THRESHOLD = 1200000;

module.exports = {
  name: 'AZTEC 持仓量增长监控',
  interval: 15 * 60 * 1000, // OI 变化慢，15分钟检查一次
  lastTriggered: 0,
  previousOI: null,
  peakOI: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const raw = await api.fetch('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=AZTEC&period=1D');
      if (!raw || !raw.data || raw.data.length === 0) return false;

      const latest = raw.data[0];
      if (!latest || latest.length < 3) return false;

      const currentOI = parseFloat(latest[1]);  // OI in contracts
      const time = new Date(parseInt(latest[0])).toISOString();

      console.log(`[AZTEC OI] 当前 OI: ${currentOI.toFixed(0)} | 阈值: ${OI_THRESHOLD}`);

      // 更新峰值追踪
      if (currentOI > this.peakOI) this.peakOI = currentOI;
      this.previousOI = currentOI;

      // 触发条件：OI 超过阈值
      if (currentOI >= OI_THRESHOLD) {
        console.log(`[AZTEC OI] 触发: OI ${currentOI.toFixed(0)} >= ${OI_THRESHOLD}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[AZTEC OI ERROR]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const tickRaw = await api.fetch('https://www.okx.com/api/v5/market/ticker?instId=AZTEC-USDT-SWAP');
      const ticker = tickRaw?.data?.[0] || {};
      const currentPrice = parseFloat(ticker.last) || 0;

      const oiRaw = await api.fetch('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=AZTEC&period=1D');
      const oiData = oiRaw?.data?.[0] || [];
      const currentOI = parseFloat(oiData[1]) || 0;

      return {
        coin: 'AZTEC',
        alertTime: new Date().toISOString(),
        currentPrice: currentPrice,
        oiCurrent: currentOI,
        oiThreshold: OI_THRESHOLD,
        oiSurpass: currentOI - OI_THRESHOLD,
        alertType: '持仓量增长',
        significance: `AZTEC 持仓量达到 ${currentOI.toFixed(0)}，已超过 ${OI_THRESHOLD} 阈值。增量资金可能正在流入，需关注价格能否延续突破。`
      };
    } catch (error) {
      console.error('[AZTEC OI collect ERROR]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-AZTEC-oi-${Date.now()}`;
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

    console.log(`[AZTEC OI触发] 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const ageHours = (Date.now() - new Date(CREATED_DATE).getTime()) / (1000 * 60 * 60);
    return ageHours < 72 ? 'active' : 'expired';
  }
};
