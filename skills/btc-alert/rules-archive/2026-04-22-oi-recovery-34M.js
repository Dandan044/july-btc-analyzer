/**
 * 持仓量回升警报（OI Recovery）
 * 触发条件：BTC 持仓量（Open Interest）从低位回升，4H OI 突破 34,000,000
 * 触发后：执行即时分析，评估新资金进场方向
 * 
 * 依据：04-22 09:00 当前OI约3370万，处于14日次高水平但价格无法突破前高。
 *       若OI从低位快速回升突破 3400万，表明有新资金进场，
 *       可能推动趋势延续（向上或向下取决于方向）。
 *       报告判断：空头控盘迹象（OI高位+价格不新高），
 *       OI回升需结合价格方向判断。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const OI_THRESHOLD = 34000000; // 3400万
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '持仓量回升警报-OI-3400万',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      // 获取4H K线数据，从中提取持仓量
      const klines = await api.getKlines('BTC', '4h', 4);
      if (!klines || klines.length === 0) return false;
      
      // 获取最新持仓量（1H K线中包含 openInterest 字段）
      const klines1h = await api.getKlines('BTC', '1h', 2);
      let currentOI = null;
      if (klines1h && klines1h.length > 0) {
        const latest = klines1h[klines1h.length - 1];
        if (latest.openInterest) {
          currentOI = latest.openInterest;
        }
      }
      
      // 若1H数据无OI，尝试用4H数据
      if (currentOI === null && klines && klines.length > 0) {
        const latest = klines[klines.length - 1];
        if (latest.openInterest) {
          currentOI = latest.openInterest;
        }
      }
      
      if (currentOI === null) {
        console.log(`[警报检查] ${this.name} | OI数据不可用，等待下次检查`);
        return false;
      }
      
      const triggered = currentOI >= OI_THRESHOLD;
      console.log(`[警报检查] ${this.name} | 当前OI: ${(currentOI/1e6).toFixed(2)}M | 阈值: ${(OI_THRESHOLD/1e6).toFixed(2)}M | 触发: ${triggered}`);
      return triggered;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines4h = await api.getKlines('BTC', '4h', 8);
      const klines1h = await api.getKlines('BTC', '1h', 6);
      
      // 获取OI数据
      let currentOI = null;
      let prevOI = null;
      
      if (klines1h && klines1h.length >= 2) {
        const latest = klines1h[klines1h.length - 1];
        const prev = klines1h[klines1h.length - 2];
        if (latest.openInterest) currentOI = latest.openInterest;
        if (prev.openInterest) prevOI = prev.openInterest;
      }
      
      if (currentOI === null && klines4h && klines4h.length >= 2) {
        const latest = klines4h[klines4h.length - 1];
        const prev = klines4h[klines4h.length - 2];
        if (latest.openInterest) currentOI = latest.openInterest;
        if (prev.openInterest) prevOI = prev.openInterest;
      }
      
      const oiChange = prevOI && currentOI 
        ? ((currentOI - prevOI) / prevOI * 100).toFixed(2) 
        : null;
      
      // 计算4H K线成交量变化
      const volChange = klines4h.length >= 2
        ? ((klines4h[klines4h.length-1].volume - klines4h[klines4h.length-2].volume) / klines4h[klines4h.length-2].volume * 100).toFixed(2)
        : null;
      
      // 价格方向判断
      const priceDir = ticker.change1h > 0 ? '向上' : ticker.change1h < 0 ? '向下' : '横盘';
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        volume24h: ticker.volume24h,
        currentOI: currentOI,
        currentOI_M: currentOI ? (currentOI / 1e6).toFixed(2) : null,
        prevOI: prevOI,
        prevOI_M: prevOI ? (prevOI / 1e6).toFixed(2) : null,
        oiChangePercent: oiChange,
        oiThreshold: OI_THRESHOLD,
        oiThreshold_M: (OI_THRESHOLD / 1e6).toFixed(2),
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        klines1h: klines1h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume,
          oi: k.openInterest ? (k.openInterest / 1e6).toFixed(2) : null
        })),
        alertType: '持仓量变化（非价格）',
        significance: `OI回升至 ${currentOI ? (currentOI/1e6).toFixed(2) : '?'}M（阈值${(OI_THRESHOLD/1e6).toFixed(2)}M），${oiChange ? '较上周期变化' + oiChange + '%' : ''}。${priceDir}动，${currentOI && prevOI && currentOI > prevOI ? '新资金正在进场' : '持仓量回升中'}，需结合价格方向判断意图`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-recovery-${Date.now()}`;
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
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
