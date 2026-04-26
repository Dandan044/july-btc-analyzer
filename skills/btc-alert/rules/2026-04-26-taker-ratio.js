/**
 * TakerRatio回升至0.95警报
 * 监控买方力量恢复信号
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-26';
const TARGET_RATIO = 0.95;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'TakerRatio回升至0.95警报',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // ⭐ 获取TakerRatio数据
      const takerData = await api.getOKXTakerRatio();
      const currentRatio = takerData.currentRatio;
      
      // ⭐ 改为回升触发：ratio >= 0.95
      const triggered = currentRatio >= TARGET_RATIO;
      
      console.log(`[🔍警报检查] [API] OKX获取4小时Taker买卖比数据 | [进度] ${this.name} | 当前比: ${currentRatio.toFixed(3)} | 阈值: ${TARGET_RATIO} | 触发: ${triggered} | [来源] 04-26 09:08日报: "TakerRatio若回升至0.95以上，买方力量恢复，可维持持有"`);
      
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const takerData = await api.getOKXTakerRatio();
      const oiData = await api.getOKXOpenInterest();
      const klines = await api.getKlines('BTC', '15m', 8);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        takerRatio: takerData.currentRatio,
        targetRatio: TARGET_RATIO,
        previousRatio: 0.896, // 09:08日报时的值
        
        openInterest: oiData.currentOI,
        
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        
        alertType: 'TakerRatio回升',
        significance: `TakerRatio=${takerData.currentRatio.toFixed(3)}回升至0.95以上，买方力量恢复，支撑可能强化`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-taker-recovery-${Date.now()}`;
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
    const today = api.getLocalDate();
    // 与持仓周期绑定，周期归档时警报失效
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};