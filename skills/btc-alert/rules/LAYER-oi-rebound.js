/**
 * LAYER 持仓量(OI)变化监控
 * OI从5.43M崩塌至2.38M，如果OI反弹>3M可能意味着新多头入场
 * 
 * 创建日期: 2026-05-13
 * 来源: alt-report-LAYER-2026-05-13-1812
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'LAYER';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000;

// OI阈值：当前OI约2.38M，如果反弹超过3M值得关注
const OI_THRESHOLD = 3000000;

module.exports = {
  name: 'LAYER-OI反弹监控',
  interval: 5 * 60 * 1000, // 5分钟检查（OI变化较慢）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const oiData = await api.getOKXOpenInterest(COIN);
      const currentOI = oiData.currentOI;
      const triggered = currentOI >= OI_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取LAYER持仓量数据 | [进度] ${this.name} | 当前OI: ${currentOI.toFixed(0)} | 阈值: ${OI_THRESHOLD} | 触发: ${triggered} | [来源] 05-13 LAYER交叉验证报告: "OI从5.43M崩塌至2.38M，如果OI反弹>3M意味着新多头入场，空头逻辑可能受挑战"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN);
      const oiData = await api.getOKXOpenInterest(COIN);
      const klines = await api.getOKXKlines(COIN, '1h', 6);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentOI: oiData.currentOI,
        oiChange24h: oiData.change24h,
        oiThreshold: OI_THRESHOLD,
        klines1h: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: 'OI反弹警报',
        message: `LAYER OI反弹至 ${oiData.currentOI.toFixed(0)}，超过阈值 ${OI_THRESHOLD}，可能意味着新多头入场`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-LAYER-OI-${Date.now()}`;
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
    ], { detached: true, stdio: 'ignore' });

    console.log(`[LAYER-OI警报触发] 已派发即时分析任务: ${jobName}`);
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