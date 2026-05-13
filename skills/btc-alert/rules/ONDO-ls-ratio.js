/**
 * ONDO 多空比监控警报
 *
 * 来源：alt-report-ONDO-2026-05-13-1518.md
 * 报告观点：当前多空比1.60偏多但已从1.82持续下降。
 *          做空触发条件：多空比跌破1.3且持续下降。
 *          做多触发条件：多空比回升确认杠杆多头出清。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'ONDO';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

const LS_THRESHOLD_LOW = 1.3;    // 多空比跌破此值触发做空信号
const LS_THRESHOLD_HIGH = 1.8;   // 多空比回升至此值触发做多信号（FOMO回归）
const CONFIRM_COUNT = 2;          // 连续2次检查确认

module.exports = {
  name: 'ONDO-多空比监控',
  interval: 5 * 60 * 1000, // 5分钟检查（多空比更新频率为日级，但API返回最新值）
  lastTriggered: 0,
  consecutiveLow: 0,
  consecutiveHigh: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const lsData = await api.getOKXLongShortRatio(COIN);
      const currentRatio = lsData?.currentRatio;

      if (!currentRatio) {
        console.log(`[🔍警报检查] ONDO多空比 | 数据不可用`);
        return false;
      }

      // 检查做空信号：多空比跌破1.3
      if (currentRatio <= LS_THRESHOLD_LOW) {
        this.consecutiveLow++;
        console.log(`[🔍警报检查] ONDO多空比 | 当前: ${currentRatio} | 跌破${LS_THRESHOLD_LOW} | 连续: ${this.consecutiveLow}/${CONFIRM_COUNT}`);
        if (this.consecutiveLow >= CONFIRM_COUNT) {
          return true;
        }
      } else {
        this.consecutiveLow = 0;
      }

      // 检查做多信号：多空比回升至1.8（FOMO回归，可能过热）
      if (currentRatio >= LS_THRESHOLD_HIGH) {
        this.consecutiveHigh++;
        console.log(`[🔍警报检查] ONDO多空比 | 当前: ${currentRatio} | 升至${LS_THRESHOLD_HIGH}+ | 连续: ${this.consecutiveHigh}/${CONFIRM_COUNT}`);
        if (this.consecutiveHigh >= CONFIRM_COUNT) {
          return true;
        }
      } else {
        this.consecutiveHigh = 0;
      }

      console.log(`[🔍警报检查] ONDO多空比 | 当前: ${currentRatio} | 阈值: <${LS_THRESHOLD_LOW} 或 >${LS_THRESHOLD_HIGH} | 无触发`);
      return false;
    } catch (error) {
      console.error('[❌警报检查错误] ONDO多空比:', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN);
      const lsData = await api.getOKXLongShortRatio(COIN);
      const currentRatio = lsData?.currentRatio;

      const signalType = currentRatio <= LS_THRESHOLD_LOW ? '多空比跌破1.3（做空信号）' :
                         currentRatio >= LS_THRESHOLD_HIGH ? '多空比升至1.8+（过热信号）' :
                         '未知';

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        longShortRatio: currentRatio,
        prevRatio: lsData?.prevRatio,
        ratioHistory: lsData?.history?.slice(0, 7),
        signalType,
        thresholds: { low: LS_THRESHOLD_LOW, high: LS_THRESHOLD_HIGH },
        alertType: '多空比异动',
        significance: `ONDO多空比${currentRatio}，${signalType}`
      };
    } catch (error) {
      console.error('[❌数据收集错误] ONDO多空比:', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-ls-${Date.now()}`;
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

    console.log(`[${COIN}多空比警报触发] ${alertData.signalType} | 比值: ${alertData.longShortRatio} | 任务: ${jobName}`);
    this.lastTriggered = Date.now();
    this.consecutiveLow = 0;
    this.consecutiveHigh = 0;
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
