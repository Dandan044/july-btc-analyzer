/**
 * OI回升至$3.5T警报
 * 监控持仓量回升信号（新资金入场）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-26';
const TARGET_OI = 3500000000; // $3.5T
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'OI回升至$3.5T警报',
  interval: 10 * 60 * 1000, // 10分钟检查一次（OI变化较慢）
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // ⭐ 获取OI数据
      const oiData = await api.getOKXOpenInterest();
      const currentOI = oiData.currentOI;
      
      const triggered = currentOI >= TARGET_OI;
      
      console.log(`[🔍警报检查] [API] OKX获取持仓量OI数据 | [进度] ${this.name} | 当前OI: $${(currentOI/1e9).toFixed(2)}T | 目标: $${(TARGET_OI/1e9).toFixed(2)}T | 触发: ${triggered} | [来源] 04-26 01:11日报: "OI若回升至$3,500M+，新资金入场信号，可考虑加仓"`);
      
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const oiData = await api.getOKXOpenInterest();
      const takerData = await api.getOKXTakerRatio();
      const klines = await api.getKlines('BTC', '15m', 8);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        openInterest: oiData.currentOI,
        targetOI: TARGET_OI,
        oiChange: oiData.currentOI - 3310000000, // 从$3.31T变化
        
        takerRatio: takerData.currentRatio,
        
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
        
        alertType: 'OI回升',
        significance: `OI回升至$${(oiData.currentOI/1e9).toFixed(2)}T，超越$3.5T阈值，新资金入场信号，可能预示趋势强化`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-${Date.now()}`;
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