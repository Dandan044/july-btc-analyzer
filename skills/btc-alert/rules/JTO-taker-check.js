/**
 * JTO Taker买卖比监控
 * 监控1H Taker买卖比是否持续偏空(<0.9)或出现反转(>1.3)
 * 持续的Taker比<0.95表明空头主导，即使价格反弹也是假象
 * Taker比>1.3表明主动买盘回归，可能止跌信号
 *
 * 来源：alt-report-JTO-2026-05-09-0248.md
 * 报告观点：Taker比已修复至0.995(接近1.0)，信号一致性大幅改善。持续的Taker比<0.9仍为极空信号，>1.3为强买盘确认
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'JTO';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4小时冷却

// 阈值：Taker比<0.9 → 极端卖盘主导 | >1.3 → 强力买盘回归
const LOW_THRESHOLD = 0.9;
const HIGH_THRESHOLD = 1.3;
const MIN_CONSECUTIVE = 2; // 至少连续2根1H K线

module.exports = {
  name: `JTO Taker比监控`,
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines1h = await api.getOKXKlines(COIN, '1H', 6, 'SWAP');

      const takerValues = klines1h.map(k => k.takerRatio).filter(v => v !== undefined && v !== null);
      if (takerValues.length < MIN_CONSECUTIVE) return false;

      // Check: consecutive low taker (bearish pressure)
      const allLow = takerValues.slice(-MIN_CONSECUTIVE).every(v => v < LOW_THRESHOLD);
      // Check: consecutive high taker (bullish pressure)
      const allHigh = takerValues.slice(-MIN_CONSECUTIVE).every(v => v > HIGH_THRESHOLD);

      const latestPrice = klines1h[klines1h.length - 1].close;
      const direction = allLow ? '看空' : (allHigh ? '看多' : '中性');
      const triggered = allLow || allHigh;

      console.log(`[🔍JTO Taker检查] 最新Taker比: [${takerValues.slice(-3).map(v => v.toFixed(3)).join(', ')}] | 连续${MIN_CONSECUTIVE}根${allLow ? '◀偏空' : (allHigh ? '▶偏多' : '中立')} | 价格: $${latestPrice} | 阈值: <${LOW_THRESHOLD}或>${HIGH_THRESHOLD} | 触发: ${triggered} | [来源] 0103报告: "Taker比0.79是最关键的预警信号"`);

      return triggered;
    } catch (error) {
      console.error('[❌JTO Taker检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    const klines1h = await api.getOKXKlines(COIN, '1H', 24, 'SWAP');
    const ticker = await api.getOKXTicker(COIN, 'SWAP');

    const takerHistory = klines1h.slice(-12).map(k => ({
      time: k.datetime,
      close: k.close,
      takerRatio: k.takerRatio
    }));

    const takerValues = klines1h.slice(-4).map(k => k.takerRatio).filter(v => v !== undefined);
    const avgTaker = takerValues.length > 0
      ? takerValues.reduce((a, b) => a + b, 0) / takerValues.length
      : 0;

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      triggerType: 'Taker买卖比异动',
      currentPrice: ticker.price,
      avgTakerRatio4h: avgTaker,
      latestTakerRatio: takerValues[takerValues.length - 1] || null,
      direction: avgTaker < 1.0 ? '卖压主导' : '买盘主导',
      takerHistory,
      reportSource: '05-09 0248 JTO即时分析交叉验证报告',
      reportConclusion: 'Taker比已从0.79修复至0.995(接近1.0)，信号一致性改善。持续<0.9仍为看跌信号，持续>1.3为强买盘信号'
    };
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-JTO-taker-${Date.now()}`;
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

    console.log(`[JTO Taker警报触发] 已派发即时分析任务: ${jobName}`);
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
