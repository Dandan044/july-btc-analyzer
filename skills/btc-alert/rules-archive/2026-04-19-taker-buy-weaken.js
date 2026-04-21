/**
 * Taker买入减弱警报 - 主动买入动能衰减预警
 * 监控 BTC Taker买卖比持续低于 0.85
 * 当前判断：20:00时段Taker比0.85，买入动能衰减
 * 
 * ========== 当前状态 ==========
 * Taker比: 0.85 (20:00时段) | 买入量: $143M (-51%)
 * 监控: Taker比 < 0.85（买入持续疲软，价格承压风险）
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-19';
const THRESHOLD_RATIO = 0.85; // 触发阈值：Taker比低于此值
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'Taker买入减弱警报',
  interval: 15 * 60 * 1000, // 15分钟检查一次（Taker数据更新频率）
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const takerData = await api.getOKXTakerRatio();
      console.log(`[警报检查] 当前Taker比: ${takerData.currentRatio}, 买入: $${(takerData.buyVolume/1e6).toFixed(1)}M, 卖出: $${(takerData.sellVolume/1e6).toFixed(1)}M`);
      
      // 触发条件：Taker比低于阈值（买入持续疲软）
      return takerData.currentRatio < THRESHOLD_RATIO;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const takerData = await api.getOKXTakerRatio();
      const klines = await api.getKlines('BTC', '15m', 8);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume,
          threshold: THRESHOLD_RATIO
        },
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: 'Taker买入减弱',
        significance: 'Taker比低于0.85，主动买入动能衰减，价格可能承压或震荡下行',
        recommendation: '观察持仓量是否下降：若OI减少+Taker比<0.8，确认下行风险加大'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-taker-weaken-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
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

    console.log(`[警报触发] 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    // 有效期：最长3天
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};