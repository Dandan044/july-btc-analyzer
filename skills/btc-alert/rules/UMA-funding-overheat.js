/**
 * UMA 资金费率过热警报
 *
 * 来源: alt-report-UMA-2026-05-12-1145.md
 * 报告观点: "资金费率>0.01%时多头过热，观望等待回调"
 * 当前资金费率0.005%（正常），监控升至0.01%以上
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'UMA';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const TARGET_FR = 0.0001; // 0.01%

module.exports = {
  name: 'UMA-资金费率过热',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const fr = await api.getOKXFundingRate(COIN, 'SWAP');
      const currentFR = parseFloat(fr.fundingRate);
      const triggered = currentFR >= TARGET_FR;

      console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率 | [进度] ${this.name} | 当前费率: ${(currentFR * 100).toFixed(4)}% | 阈值: ${(TARGET_FR * 100).toFixed(2)}% | 触发: ${triggered} | [来源] 05-12 UMA首周期报告: "资金费率>0.01%时多头过热，观望等待回调"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const fr = await api.getOKXFundingRate(COIN, 'SWAP');
      const klines = await api.getOKXKlines(COIN, '1h', 6, 'SWAP');

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentFundingRate: parseFloat(fr.fundingRate),
        nextFundingRate: fr.nextFundingRate ? parseFloat(fr.nextFundingRate) : null,
        threshold: TARGET_FR,
        currentPrice: klines[klines.length - 1].close,
        klines1h: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: '资金费率过热',
        significance: `资金费率${(parseFloat(fr.fundingRate) * 100).toFixed(4)}%超过阈值${(TARGET_FR * 100).toFixed(2)}%，多头过热信号`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-fr-${Date.now()}`;
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

    console.log(`[${COIN}警报触发] 资金费率过热: ${(data.currentFundingRate * 100).toFixed(4)}% | 已派发即时分析任务: ${jobName}`);
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
