/**
 * 阻力位突破警报
 * 监控 BTC 价格突破关键阻力位 $76,000
 * 当前持仓止损触发价$76,522，此警报作为止损触发前预警
 * 突破$76,000确认多头趋势，止损可能触发
 *
 * ========== 当前状态 ==========
 * 持仓: sug-001 做空 | 入场$74,600.1 | 止损触发价$76,522
 * 监控: 价格突破 $76,000（止损触发前预警）
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-16';
const TARGET_PRICE = 76000;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '阻力位突破预警-76000',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标阻力: ${TARGET_PRICE}`);
      return ticker.price >= TARGET_PRICE;
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
        positionStatus: {
          entryPrice: 74600.1,
          stopLossTrigger: 76522,
          takeProfit: 72478,
          unrealizedPnl: ((74600.1 - ticker.price) / 74600.1 * 100).toFixed(2) + '%'
        },
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        triggerPrice: TARGET_PRICE,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '阻力位突破预警',
        significance: '突破$76,000关键阻力，止损触发价$76,522即将触发。持仓sug-001做空亏损预计-1.9%',
        recommendation: '确认突破后，等待OCO止损订单自动执行。若突破后回落，观察是否假突破'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-76000-${Date.now()}`;
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
    // 有效期：持仓关闭为止，最长3天
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};