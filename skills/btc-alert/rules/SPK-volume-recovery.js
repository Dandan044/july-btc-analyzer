/**
 * SPK 成交量恢复预警
 * 监控 1H 成交量是否恢复至正常水平（>500K/1h）
 * 来源: alt-report-SPK-2026-05-08-2246.md
 * 观点: "成交量是唯一的先行指标。在量能恢复之前，不执行任何方向的开仓操作"
 * 终止观察条件: 24h内成交量恢复至24h均值以上（单1H > 500K）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'SPK';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 4 * 60 * 60 * 1000;  // 非价格警报，4小时冷却

// 成交量恢复阈值：单1H成交量 > 500K SPK
const VOLUME_THRESHOLD = 500000;
// 确认窗口：连续2根1H K线成交量均超过阈值
const CONFIRM_COUNT = 2;

module.exports = {
  name: `${COIN}成交量恢复预警`,
  interval: 15 * 60 * 1000,  // 15分钟低频检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getOKXKlines(COIN, '1H', 6, 'SWAP');
      // 取最近几根的成交量（volume = volCcy USDT，volumeBTC = 币本位量）
      const recentVolumes = klines.map(k => k.volumeBTC || k.volume);
      const aboveThreshold = recentVolumes.filter(v => v >= VOLUME_THRESHOLD).length;
      const latestVolume = recentVolumes[0] || 0;
      const triggerCount = Math.min(CONFIRM_COUNT, klines.length);
      const triggered = aboveThreshold >= triggerCount;

      console.log(`[🔍警报检查] [API] OKX获取${COIN} 1H成交量(最近6根) | [进度] ${this.name} | 最新成交量: ${(latestVolume/1000).toFixed(1)}K | 阈值: ${(VOLUME_THRESHOLD/1000).toFixed(1)}K | 超过阈值根数: ${aboveThreshold}/${triggerCount} | 触发: ${triggered} | [来源] 05-08 22:46即时分析: "成交量是先行指标，恢复至>$500K/1h后重新评估"`);

      if (triggered) {
        return true;
      }
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const [klines, ticker] = await Promise.all([
        api.getOKXKlines(COIN, '1H', 6, 'SWAP'),
        api.getOKXTicker(COIN, 'SWAP')
      ]);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: `${COIN}成交量恢复预警`,
        volumeData: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volumeBTC || k.volume,
          volumeFormatted: `$${(k.volume).toFixed(0)}`
        })),
        threshold: VOLUME_THRESHOLD,
        thresholdFormatted: `${(VOLUME_THRESHOLD / 1000).toFixed(0)}K SPK/1H`,
        confirmCount: CONFIRM_COUNT,
        significance: `${COIN} 1H成交量已恢复至${(VOLUME_THRESHOLD/1000).toFixed(0)}K以上，市场活跃度回升，需要重新评估所有仓位策略`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-volume-${Date.now()}`;
    const model = CONFIG.trigger.altcoin.model;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[${COIN}成交量警报触发] 已派发即时分析: ${jobName}`);
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
