/**
 * 支撑位回踩确认警报
 * 监控 BTC 价格回踩 $75,500 支撑位，确认是否有效
 * 
 * 报告依据：价格已突破 $75,500（阻力变支撑），若回踩至 $75,000-$75,500 区间，
 * 观察能否在此处企稳，确认支撑有效性后可能提供做多机会。
 * 
 * ========== 监控逻辑 ==========
 * 延迟触发：价格下跌至 $75,500-$75,800 区间，停留20分钟以上
 * 触发条件：延迟触发（非立即触发），观察回踩后的稳定性
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const UPPER_BOUND = 75800;   // 上边界：$75,800
const LOWER_BOUND = 75000;   // 下边界：$75,000（若跌破$75,000，支撑失效）
const DELAY_MS = 20 * 60 * 1000; // 20分钟延迟触发
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

let entryTime = null;  // 价格进入区间的时间

module.exports = {
  name: '支撑位回踩确认-75500',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;
      
      console.log(`[警报检查] 当前价格: ${price}, 目标区间: [${LOWER_BOUND}, ${UPPER_BOUND}]`);
      
      // 检查价格是否进入区间
      if (price >= LOWER_BOUND && price <= UPPER_BOUND) {
        if (entryTime === null) {
          entryTime = Date.now();
          console.log(`[计时开始] 价格进入区间 ${LOWER_BOUND}-${UPPER_BOUND}，计时中...`);
        }
        
        // 检查是否已停留足够时间
        const elapsed = Date.now() - entryTime;
        if (elapsed >= DELAY_MS) {
          console.log(`[触发条件满足] 价格在区间停留 ${(elapsed / 60000).toFixed(1)} 分钟`);
          return true;
        } else {
          console.log(`[等待中] 已停留 ${(elapsed / 60000).toFixed(1)}/${DELAY_MS / 60000} 分钟`);
          return false;
        }
      } else {
        // 价格离开区间，重置计时
        if (entryTime !== null) {
          console.log(`[重置] 价格离开区间，计时重置`);
          entryTime = null;
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
      const klines = await api.getKlines('BTC', '4h', 6);
      const oiData = await api.getOKXOpenInterest();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        targetZone: {
          upper: UPPER_BOUND,
          lower: LOWER_BOUND,
          description: '$75,000-$75,800 区间'
        },
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
        alertType: '支撑位回踩确认',
        message: '价格回踩 $75,500 支撑区间，观察是否企稳',
        significance: '回踩确认后若企稳，可考虑做多；若跌破 $75,000，支撑失效'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-retest-${Date.now()}`;
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
    entryTime = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
