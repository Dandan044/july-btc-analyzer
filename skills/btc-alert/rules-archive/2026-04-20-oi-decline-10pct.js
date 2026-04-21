/**
 * OI多空平仓加速警报
 * 监控 BTC 持仓量（Open Interest）24小时内下降超过10%
 * 
 * 报告依据：OI从4月18日峰值3,635,976连续两日下降（-6.0%、-0.9%），
 * 多头正在平仓而非空头新建仓位，这是回调而非反转信号。
 * 若OI加速下降超过10%，可能预示局部见底（多头恐慌性平仓结束）。
 * 
 * ========== 当前状态 ==========
 * OI: 3,386,283（从峰值3,635,976已降-6.9%）
 * 监控: OI 24h下降 > 10%（极端平仓信号，可能见底）
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const OI_DROP_THRESHOLD = 10; // 触发阈值：24h OI下降超过10%
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'OI多空平仓加速警报',
  interval: 15 * 60 * 1000, // 15分钟检查一次（OI数据更新频率）
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      const change24h = oiData.change24h; // percentage, can be negative

      console.log(`[警报检查] OI当前: ${oiData.currentOI}, 24h变化: ${change24h.toFixed(2)}%`);

      // 触发条件：24h OI下降超过阈值（负值表示下降）
      return change24h <= -OI_DROP_THRESHOLD;
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
      const takerData = await api.getOKXTakerRatio();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h,
          threshold: OI_DROP_THRESHOLD
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
        alertType: 'OI多空平仓加速',
        significance: 'OI 24h下降超过10%，多头恐慌性平仓可能接近尾声，见底信号',
        recommendation: '观察价格是否在$71,031-$73,500区间企稳：若OI见底+价格企稳，可能是较好的分批做多时机'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-drop-${Date.now()}`;
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
    return daysDiff <= 2 ? 'active' : 'expired'; // 有效期2天
  }
};
