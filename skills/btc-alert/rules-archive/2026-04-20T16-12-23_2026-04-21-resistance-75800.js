/**
 * 阻力位突破警报
 * 监控 BTC 价格突破 $75,800 并延迟确认
 * 
 * 报告依据：$75,800 是 4月19日收盘位，也是路径一（上攻 $76,500）的确认条件。
 * 4小时收盘站稳 $75,800，意味着短期趋势转多，可等待 TP2（$76,500）触发。
 * 使用延迟触发（30分钟），避免假突破。
 * 
 * ========== 当前状态 ==========
 * 当前价格: $75,521
 * 目标位: $75,800
 * 距离: +$279
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const TARGET_PRICE = 75800;
const DELAY_MS = 30 * 60 * 1000; // 30分钟延迟确认
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

let breakthroughTime = null; // 突破发生时间

module.exports = {
  name: '阻力位突破警报-75800',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;

      console.log(`[警报检查] 当前价格: ${price}, 目标阻力: ${TARGET_PRICE}`);

      if (price >= TARGET_PRICE) {
        if (breakthroughTime === null) {
          breakthroughTime = Date.now();
          console.log(`[突破检测] 价格已突破 ${TARGET_PRICE}，开始计时...`);
        }

        const elapsed = Date.now() - breakthroughTime;
        if (elapsed >= DELAY_MS) {
          console.log(`[延迟确认] 突破已稳定 ${(elapsed / 60000).toFixed(1)} 分钟，触发警报`);
          return true;
        } else {
          console.log(`[等待确认] 突破已持续 ${(elapsed / 60000).toFixed(1)}/${DELAY_MS / 60000} 分钟`);
          return false;
        }
      } else {
        if (breakthroughTime !== null) {
          console.log(`[突破失效] 价格回落至 ${price}，重置计时`);
          breakthroughTime = null;
        }
        return false;
      }
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 10);
      const oiData = await api.getOKXOpenInterest();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggerPrice: TARGET_PRICE,
        breakthroughTime: breakthroughTime ? new Date(breakthroughTime).toISOString() : null,
        delayMinutes: DELAY_MS / 60000,
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '阻力位突破确认',
        message: '价格突破 $75,800 并稳定，确认短期转多信号',
        significance: '路径一确认（40%概率），可等待 TP2（$76,500）目标'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-75800-${Date.now()}`;
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
    breakthroughTime = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
