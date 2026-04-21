/**
 * 阻力位突破确认警报
 * 监控 BTC 价格突破 $75,742（晚间高点）并延迟确认
 * 
 * 报告依据：
 * - 路径三（25%概率）：突破 $75,742 继续上攻，上方目标 $76,500
 * - 阻力位：$75,742（晚间高点）、$76,500（整数关口）
 * - 需配合 OI 回升才视为有效突破
 * 
 * ========== 监控逻辑 ==========
 * 延迟触发：价格突破 $75,742 后，等待30分钟确认
 * 触发条件：价格持续在 $75,742 以上运行30分钟
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const TARGET_PRICE = 75742; // 晚间高点
const DELAY_MS = 30 * 60 * 1000; // 30分钟延迟确认
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

let breakthroughTime = null;

module.exports = {
  name: '阻力位突破确认-75742',
  interval: 3 * 60 * 1000,
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
          console.log(`[触发条件满足] 突破已稳定 ${(elapsed / 60000).toFixed(1)} 分钟`);
          return true;
        } else {
          console.log(`[等待确认] 突破已持续 ${(elapsed / 60000).toFixed(1)}/${DELAY_MS / 60000} 分钟`);
          return false;
        }
      } else {
        if (breakthroughTime !== null) {
          console.log(`[重置] 价格回落至 ${price}，计时重置`);
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
      const klines = await api.getKlines('BTC', '4h', 6);
      const oiData = await api.getOKXOpenInterest();
      const takerData = await api.getOKXTakerRatio();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggerPrice: TARGET_PRICE,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume
        },
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '阻力位突破确认',
        message: `价格突破 $75,742 并稳定30分钟，确认突破有效`,
        significance: '突破 $75,742 视为多头信号，上方目标 $76,500；若突破需配合 OI 回升'
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