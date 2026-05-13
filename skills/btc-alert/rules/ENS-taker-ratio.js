/**
 * ENS Taker买卖比警报
 * 监控主动卖出力量增强（Taker买卖比持续低于0.8）
 *
 * 来源: alt-report-ENS-2026-05-11-1936.md
 * 报告观点: "4H级别Taker买卖比从1.38降至0.95，主动买入在减弱，主动卖出在增强。
 *           散户做多vs聪明钱卖出，这是经典的背离。"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'ENS';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const TAKER_THRESHOLD = 0.8;         // Taker买卖比阈值
const CONSECUTIVE_COUNT = 2;         // 需要连续2个4H周期低于阈值

module.exports = {
  name: 'ENS-Taker买卖比恶化',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,
  lowCount: 0, // 连续低于阈值的计数

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取Taker买卖比数据（1H周期，取最近2个点）
      const takerData = await api.getOKXTakerRatio(COIN);
      const currentRatio = takerData.currentRatio;

      if (currentRatio < TAKER_THRESHOLD) {
        this.lowCount++;
      } else {
        this.lowCount = 0;
      }

      const triggered = this.lowCount >= CONSECUTIVE_COUNT;

      console.log(`[🔍警报检查] [API] OKX获取${COIN} Taker买卖比 | [进度] ${this.name} | 当前比: ${currentRatio?.toFixed(4) || 'N/A'} | 阈值: <${TAKER_THRESHOLD} | 连续低计数: ${this.lowCount}/${CONSECUTIVE_COUNT} | 触发: ${triggered} | [来源] 05-11 19:36山寨报告: "Taker买卖比从1.38降至0.95，主动卖出增强，散户做多vs聪明钱卖出是经典背离"`);

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
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines = await api.getOKXKlines(COIN, '1h', 6, 'SWAP');

      let oiData = null, lsData = null;
      try { oiData = await api.getOKXOpenInterest(COIN); } catch (e) { /* 静默 */ }
      try { lsData = await api.getOKXLongShortRatio(COIN); } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        takerRatio: {
          current: typeof ticker !== 'undefined' ? null : null,
          threshold: TAKER_THRESHOLD,
          consecutiveLow: this.lowCount
        },
        openInterest: oiData?.currentOI,
        longShortRatio: lsData?.currentRatio,
        klines1h: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: 'Taker买卖比恶化',
        significance: `ENS Taker买卖比连续${this.lowCount}个周期低于${TAKER_THRESHOLD}，主动卖出力量持续增强，与散户极端做多形成背离`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-taker-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[${COIN}警报触发] Taker买卖比恶化，已派发即时分析任务: ${jobName}`);

    this.lastTriggered = Date.now();
    this.lowCount = 0;
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
