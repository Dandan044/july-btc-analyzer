/**
 * BB带宽扩张警报（非价格类）
 * 
 * 监控BTC 1小时K线波动率变化，检测挤压后的方向性突破
 * BB带宽从<10%挤压状态扩张至>1.2% 1h振幅时触发
 * 
 * 来源: 2026-05-08 09:01日报 (cycle-20260508-001)
 * 报告核心判断: BB带宽9.5%<10%挤压中，历史数据中每次挤压后3-5天出现方向性突破
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'BTC';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000;

// 挤压后扩张触发阈值：单根1h K线振幅超过此值即触发
const RANGE_THRESHOLD = 1.2; // %

// 挤压状态阈值：振幅连续N小时低于此值为挤压
const SQUEEZE_THRESHOLD = 0.6; // %

// 确认挤压需要的连续小时数
const SQUEEZE_HOURS = 48; // 2天

module.exports = {
  name: 'BB带宽扩张警报-波动率突破',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取最近50小时的1h K线（覆盖检查过往挤压状态）
      const klines = await api.getKlines('BTC', '1h', 50);

      // 计算最新6根K线的最大振幅
      const recentKlines = klines.slice(-6);
      const maxRange = Math.max(...recentKlines.map(k =>
        ((k.high - k.low) / k.close) * 100
      ));

      // 检查过去48h是否处于挤压状态
      const squeezeKlines = klines.slice(-SQUEEZE_HOURS);
      const squeezeRanges = squeezeKlines.map(k => ((k.high - k.low) / k.close) * 100);
      const avgSqueezeRange = squeezeRanges.reduce((a, b) => a + b, 0) / squeezeRanges.length;
      const isSqueeze = avgSqueezeRange < SQUEEZE_THRESHOLD;

      // 检测：挤压状态下出现大振幅K线
      const triggered = isSqueeze && maxRange >= RANGE_THRESHOLD;

      const latestPrice = klines[klines.length - 1].close;
      console.log(`[🔍警报检查] [API] OKX获取BTC 50根1小时K线 | [进度] ${this.name} | 1h最大振幅: ${maxRange.toFixed(2)}% | 48h均值: ${avgSqueezeRange.toFixed(2)}% | 挤压状态: ${isSqueeze ? '是' : '否'} | 触发: ${triggered} | [来源] 2026-05-08 09:01日报: "BB带宽收窄至9.5%，挤压状态，预计3-5天方向突破"`);

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines1h = await api.getKlines('BTC', '1h', 48);
      const klines4h = await api.getKlines('BTC', '4h', 12);

      // 计算近期振幅统计
      const ranges = klines1h.map(k => ({
        time: k.datetime,
        range: ((k.high - k.low) / k.close) * 100,
        direction: k.close > k.open ? 'up' : 'down',
        volume: k.volume
      }));

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,

        // 波动率数据
        volatility: {
          currentMax1hRange: Math.max(...klines1h.slice(-6).map(k => ((k.high - k.low) / k.close) * 100)),
          avg48hRange: ranges.reduce((s, r) => s + r.range, 0) / ranges.length,
          squeezeState: '扩张突破',
          thresholdPercent: RANGE_THRESHOLD
        },

        // 4H趋势方向判断
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
          range: ((k.high - k.low) / k.close) * 100
        })),

        // 价格变化
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },

        // 扩张突破K线详情
        expansionCandles: ranges.filter(r => r.range >= RANGE_THRESHOLD).slice(-3),

        alertType: '波动率扩张突破',
        significance: `BB挤压后波动率扩张，1h最大振幅${Math.max(...klines1h.slice(-6).map(k => ((k.high - k.low) / k.close) * 100)).toFixed(2)}%超过阈值${RANGE_THRESHOLD}%，方向突破确认`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-btc-vol-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/instant-analysis-stage1.md 执行数据获取\n2. 读取 tasks/daily-report-stage2.md 执行技术分析\n3. 读取 tasks/daily-report-stage3.md 执行仓位管理\n4. 读取 tasks/daily-report-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.btc.model;
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

    console.log(`[警报触发] 已派发即时分析任务: ${jobName} | 波动率突破触发`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const nowDate = new Date(today);
    const daysDiff = Math.floor((nowDate - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
