/**
 * 入场取消警报（反弹监控）
 * 监控 BTC 价格反弹超过 $74,500
 * 如果反弹超过此价位，说明跌破$73,900无效，取消做空入场
 *
 * ========== 当前状态 ==========
 * 建议状态: pending_entry | 等待入场确认
 * 监控: 价格反弹不超过 $74,500
 * 触发条件: 价格反弹超过 $74,500 → 取消入场
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-15';
const CANCEL_PRICE = 74500; // 反弹超过此价位取消入场
const COOLDOWN_MS = 30 * 60 * 1000; // 30分钟冷却

module.exports = {
  name: '入场取消警报-反弹超过74500',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[入场监控] 当前价格: ${ticker.price}, 取消阈值: ${CANCEL_PRICE}`);
      // 反弹超过$74,500触发警报
      return ticker.price >= CANCEL_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 8);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        triggerPrice: CANCEL_PRICE,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '入场条件取消',
        significance: '价格反弹超过$74,500，跌破$73,900可能无效，建议取消做空入场',
        recommendation: '更新建议状态为取消，等待新的交易机会'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-cancel-entry-${Date.now()}`;
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
    // 入场监控警报有效期1天，如果建议状态变为open或取消，归档此警报
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 1 ? 'active' : 'expired';
  }
};