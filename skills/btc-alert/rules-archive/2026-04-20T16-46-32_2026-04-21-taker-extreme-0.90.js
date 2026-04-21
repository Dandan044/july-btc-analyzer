/**
 * Taker买卖比极端警报
 * 监控 OKX Taker 买卖比跌破 0.90（极端卖方主导）
 * 
 * 报告依据：
 * - 最新 1H Taker Ratio = 0.913（卖方轻微占优）
 * - 21:00 曾出现极端值 0.849，之后回升至 0.985
 * - Taker Ratio < 0.90 通常伴随价格下跌，是空头力量积聚的信号
 * 
 * ========== 监控逻辑 ==========
 * Taker Ratio < 0.90 立即触发
 * 冷却时间 2 小时
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const TAKER_THRESHOLD = 0.90; // 极端卖方信号阈值
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

module.exports = {
  name: 'Taker买卖比极端警报-0.90',
  interval: 15 * 60 * 1000, // 15分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const takerData = await api.getOKXTakerRatio();
      const ticker = await api.getTicker('BTC');
      
      const currentRatio = takerData.currentRatio;
      const currentPrice = ticker.price;
      
      console.log(`[警报检查] Taker Ratio: ${currentRatio}, 当前价格: ${currentPrice}`);
      console.log(`[趋势] 昨日同期: ${takerData.prevRatio}`);
      
      return currentRatio < TAKER_THRESHOLD;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1h', 6);
      const oiData = await api.getOKXOpenInterest();
      const takerData = await api.getOKXTakerRatio();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume,
          threshold: TAKER_THRESHOLD
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: 'Taker买卖比极端',
        message: `Taker Ratio 跌破 ${TAKER_THRESHOLD}，卖方极端主导`,
        significance: 'Taker < 0.90 通常伴随价格下跌，是空头力量积聚的信号，需关注 $75,277 支撑'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-taker-extreme-${Date.now()}`;
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
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};