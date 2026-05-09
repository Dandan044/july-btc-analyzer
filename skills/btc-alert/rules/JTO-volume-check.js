/**
 * JTO 成交量异动监控
 * 监控1H成交量是否出现异常飙升（>5x平均值），标志回调结束/新波段启动
 *
 * 来源：alt-report-JTO-2026-05-09-0248.md
 * 报告观点：成交量已恢复至$3.26M/1H(+$9.24M/4H)，量能维度已通过验证。后续若出现成交量异常放大(>$5M/1H+3x均值)为新波段启动信号
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'JTO';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4小时冷却（成交量无需太敏感）

// 成交量阈值：1H成交量超过此值触发（USDT）
// 当前1H成交量约$490K，正常值$1-3M，设置$5M为异常放大阈值
const VOLUME_THRESHOLD = 5000000;
const MIN_HOURS_DATA = 6;  // 至少6小时数据用于均值计算

module.exports = {
  name: `JTO成交量异动监控`,
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines1h = await api.getOKXKlines(COIN, '1H', 24, 'SWAP');
      const latestVol = klines1h[klines1h.length - 1].volume;
      const recentVols = klines1h.slice(-MIN_HOURS_DATA, -1).map(k => k.volume);
      const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
      const volRatio = avgVol > 0 ? latestVol / avgVol : 0;
      const triggered = latestVol >= VOLUME_THRESHOLD && volRatio >= 3;

      console.log(`[🔍JTO量检查] [API] OKX获取JTO 1H K线 | [进度] 成交量监控 | 当前1H量: $${(latestVol/1e6).toFixed(2)}M | 近${MIN_HOURS_DATA}h均值: $${(avgVol/1e6).toFixed(2)}M | 倍率: ${volRatio.toFixed(1)}x | 阈值: $${(VOLUME_THRESHOLD/1e6).toFixed(1)}M, 3x | 触发: ${triggered} | [来源] 05-08 1607报告: "量能萎缩至$490K/小时，若放量至$3M+可能是回调结束信号"`);

      return triggered;
    } catch (error) {
      console.error('[❌JTO量检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    const klines1h = await api.getOKXKlines(COIN, '1H', 48, 'SWAP');
    const ticker = await api.getOKXTicker(COIN, 'SWAP');
    const recentVols = klines1h.slice(-24).map(k => ({
      time: k.datetime,
      volume: k.volume,
      close: k.close
    }));
    const latestVol = klines1h[klines1h.length - 1].volume;
    const avgVol = klines1h.slice(-12, -1).reduce((a, b) => a + b.volume, 0) / 11;

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      triggerType: '成交量异动',
      currentPrice: ticker.price,
      currentVolume1h: latestVol,
      avgVolume12h: avgVol,
      volumeRatio: avgVol > 0 ? (latestVol / avgVol).toFixed(1) : 'N/A',
      recentVolumes: recentVols.slice(-12),
      reportSource: '05-09 0248 JTO即时分析交叉验证报告',
      reportConclusion: '成交量已恢复至$3.26M/1H，4H总量$9.24M(>8M阈值)。后续若再出现>$5M/1H+3x均值为新波段启动信号'
    };
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-JTO-vol-${Date.now()}`;
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
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[JTO量警报触发] 已派发即时分析任务: ${jobName}`);
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
