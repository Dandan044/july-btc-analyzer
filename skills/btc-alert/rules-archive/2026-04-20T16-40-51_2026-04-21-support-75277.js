/**
 * 支撑位跌破警报
 * 监控 BTC 价格跌破 $75,277（4小时即时支撑）
 * 
 * 报告依据：
 * - 路径二（35%概率）：跌破 $75,277，继续回落至 $73,834
 * - 即时支撑 $75,277 是今晚的关键多空分水岭
 * - 若跌破，高点逐次降低的下降结构延续
 * 
 * ========== 监控逻辑 ==========
 * 价格跌破 $75,277 时立即触发（不延迟）
 * 配合 4H 收盘确认
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const SUPPORT_PRICE = 75277; // 4小时即时支撑
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

module.exports = {
  name: '支撑位跌破警报-75277',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;
      
      console.log(`[警报检查] 当前价格: ${price}, 支撑位: ${SUPPORT_PRICE}`);
      
      return price < SUPPORT_PRICE;
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
        supportPrice: SUPPORT_PRICE,
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
        alertType: '支撑位跌破',
        message: `价格跌破 $75,277，4H 高点逐次降低的下降结构延续`,
        significance: '跌破 $75,277 意味着空头主导，下方目标 $73,834（38.2%斐波回撤位）'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-break-${Date.now()}`;
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