/**
 * 阻力位突破警报 - $78,420
 * 触发条件：BTC 价格突破 $78,420 并站稳（延迟确认15分钟）
 * 触发后：执行即时分析，评估是否做多
 * 
 * 依据：04-22 16:28即时分析报告判断"$78,420 是4H波段高点，本轮反弹极限，
 *       历史四次触碰均未有效突破"，"若放量突破（成交量高于 $2B，4H收盘高于 $78,420），
 *       说明趋势延续，$79,000-$80,000 可期"。
 *       当前价格 $77,994.8，距 $78,420 仅$425（0.55%），是即时最关键压力。
 * 
 * 注意：使用延迟确认（15分钟）避免假突破
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const TARGET_PRICE = 78420;
const DELAY_MS = 15 * 60 * 1000; // 突破后等待15分钟确认
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '阻力位突破警报-78420',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  // 延迟触发状态管理
  breakthroughTime: null,
  lastCheckedPrice: null,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;

      if (currentPrice >= TARGET_PRICE) {
        // 突破发生
        if (!this.breakthroughTime) {
          this.breakthroughTime = Date.now();
          console.log(`[突破检测] 价格已突破 ${TARGET_PRICE}，当前价: ${currentPrice}，开始计时...`);
        }
        
        // 检查是否已延迟足够时间
        if (Date.now() - this.breakthroughTime >= DELAY_MS) {
          console.log(`[延迟确认] 突破已稳定 ${DELAY_MS / 60000} 分钟，触发警报`);
          return true;
        }
        
        const elapsedMs = Date.now() - this.breakthroughTime;
        const elapsedMins = Math.floor(elapsedMs / 60000);
        console.log(`[等待确认] 突破已持续 ${elapsedMins} 分钟，等待 ${DELAY_MS / 60000} 分钟`);
      } else {
        // 价格回落，重置计时
        if (this.breakthroughTime) {
          console.log(`[突破失效] 价格回落至 ${currentPrice}，重置计时`);
          this.breakthroughTime = null;
        }
      }
      
      this.lastCheckedPrice = currentPrice;
      return false;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines15m = await api.getKlines('BTC', '15m', 10);
      const klines4h = await api.getKlines('BTC', '4h', 4);
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        volume24h: ticker.volume24h,
        triggerPrice: TARGET_PRICE,
        breakthroughTime: this.breakthroughTime ? new Date(this.breakthroughTime).toISOString() : null,
        delayMinutes: DELAY_MS / 60000,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '阻力位突破（上方价格）',
        significance: `价格已突破 ${TARGET_PRICE} 并稳定15分钟。$78,420 为4H波段高点，突破后下一目标 $79,000-$80,000。需确认4H成交量是否放量（>$2B），longShortRatio是否回升至0.75+。`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-78420-${Date.now()}`;
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

    console.log(`[警报触发] ${this.name} | 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
    this.breakthroughTime = null; // 重置突破时间
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
