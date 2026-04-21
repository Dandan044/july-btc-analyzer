/**
 * 上方阻力突破警报
 * 监控 BTC 价格突破 $75,550（4H 23.6% 斐波回撤位）
 *
 * 报告依据：当前价格 $75,433 处于 23.6% 斐波位 $75,550 下方 $117 点，
 * 是短线阻力区域。若 4H 收盘能站上 $75,550，震荡偏多格局延续。
 *
 * ========== 监控逻辑 ==========
 * 延迟触发：价格突破 $75,550 后等待 20 分钟确认
 * 触发条件：突破后观察稳定性，避免假突破
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const TARGET_PRICE = 75550; // 4H 23.6% 斐波回撤位
const DELAY_MS = 20 * 60 * 1000; // 20分钟延迟确认
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

let breakthroughTime = null; // 突破发生时间

module.exports = {
  name: '上方阻力突破-75550',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;

      console.log(`[警报检查] 当前价格: ${price}, 目标: ${TARGET_PRICE}`);

      if (price >= TARGET_PRICE) {
        if (breakthroughTime === null) {
          breakthroughTime = Date.now();
          console.log(`[突破检测] 价格已突破 ${TARGET_PRICE}，开始计时...`);
        }

        const elapsed = Date.now() - breakthroughTime;
        if (elapsed >= DELAY_MS) {
          console.log(`[延迟确认] 突破已稳定 ${(elapsed / 60000).toFixed(1)} 分钟`);
          return true;
        } else {
          console.log(`[等待确认] 突破已持续 ${(elapsed / 60000).toFixed(1)}/${DELAY_MS / 60000} 分钟`);
          return false;
        }
      } else {
        if (breakthroughTime !== null) {
          console.log(`[重置] 价格回落至 ${price}，重置计时`);
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
      const klines = await api.getKlines('BTC', '4h', 4);
      const oiData = await api.getOKXOpenInterest();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        targetPrice: TARGET_PRICE,
        breakthroughTime: breakthroughTime ? new Date(breakthroughTime).toISOString() : null,
        delayMinutes: DELAY_MS / 60000,
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '上方阻力突破',
        significance: '突破 $75,550 代表短线阻力已过，需观察 OI 是否配合回升',
        recommendation: '若 OI 同时回升，可考虑做多；否则可能仍是假突破'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-${Date.now()}`;
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
