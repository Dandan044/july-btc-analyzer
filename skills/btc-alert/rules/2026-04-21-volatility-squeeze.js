/**
 * 非价格警报：波动率收窄警报
 * 监控 BTC 小时振幅连续收缩（连续3小时振幅<1%）
 * 适用场景：波动率极度收缩往往对应变盘前的蓄势阶段
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const MIN_RANGE_PCT = 1.0; // 触发阈值：振幅小于1%
const CONSECUTIVE_HOURS = 3; // 连续小时数
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '波动率收窄警报',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取最近N小时的K线
      const klines = await api.getOKXKlines('BTC', '1H', CONSECUTIVE_HOURS);

      // 计算每根K线的振幅
      const ranges = klines.map(k => {
        const range = ((k.high - k.low) / k.close) * 100;
        return range;
      });

      // 判断是否连续N小时振幅都小于阈值
      const allNarrow = ranges.every(r => r < MIN_RANGE_PCT);

      console.log(`[警报检查] 近${CONSECUTIVE_HOURS}小时振幅: ${ranges.map(r => r.toFixed(2) + '%').join(' / ')}`);
      console.log(`[警报检查] 均值: ${(ranges.reduce((a,b) => a+b,0)/ranges.length).toFixed(2)}%, 阈值: ${MIN_RANGE_PCT}%`);

      return allNarrow;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('BTC');
      const klines = await api.getOKXKlines('BTC', '1H', CONSECUTIVE_HOURS + 2);

      const ranges = klines.map(k => ({
        time: k.datetime,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        rangePct: ((k.high - k.low) / k.close * 100).toFixed(2)
      }));

      const avgRange = ranges.slice(0, CONSECUTIVE_HOURS).reduce((sum, r) => sum + parseFloat(r.rangePct), 0) / CONSECUTIVE_HOURS;

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        recentKlines: ranges,
        averageRange: avgRange.toFixed(2),
        threshold: MIN_RANGE_PCT,
        consecutiveHours: CONSECUTIVE_HOURS,
        alertType: '波动率收窄',
        significance: `连续${CONSECUTIVE_HOURS}小时振幅低于${MIN_RANGE_PCT}%，市场极度收缩，可能即将变盘`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const spawnMessage = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;
    const now = new Date().toISOString();
    const jobName = `alert-volatility-${Date.now()}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', spawnMessage,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
