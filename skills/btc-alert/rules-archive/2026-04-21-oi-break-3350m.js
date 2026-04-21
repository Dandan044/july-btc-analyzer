/**
 * OI 趋势突破警报
 * 监控 BTC 持仓量（Open Interest）突破 33.5亿美元
 * 
 * 报告依据：OI 是核心矛盾！从04-18峰值 36.36亿至今持续收缩，
 * 当前 OI=33.20亿。OI 能否突破 33.5亿是确认趋势的关键信号。
 * - 若 OI > 33.5亿 + 价格配合 → 新资金入场，上涨趋势确认
 * - 若 OI 持续 < 33.5亿 → 震荡格局延续，无趋势
 * 
 * ========== 当前状态 ==========
 * OI 当前: 33.20亿（$76,040价格时）
 * 监控目标: OI 突破 33.5亿
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const OI_THRESHOLD = 3350000000; // 33.5亿美元 = 33.5亿OI
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'OI趋势突破警报-335亿',
  interval: 15 * 60 * 1000, // 15分钟检查一次（OI数据日更新，但监控4H结构）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      console.log(`[警报检查] OI当前: ${(oiData.currentOI / 1e8).toFixed(2)}亿, 阈值: ${(OI_THRESHOLD / 1e8).toFixed(2)}亿`);
      return oiData.currentOI >= OI_THRESHOLD;
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
          threshold: OI_THRESHOLD,
          peak: 3636000000, // 04-18峰值 36.36亿
          currentVsPeak: ((oiData.currentOI / 3636000000 - 1) * 100).toFixed(1) + '%'
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
        alertType: 'OI趋势突破',
        significance: `OI 突破 33.5亿，新资金入场确认！当前 OI=${(oiData.currentOI / 1e8).toFixed(2)}亿（峰值36.36亿的${((oiData.currentOI / 3636000000) * 100).toFixed(1)}%）`,
        recommendation: 'OI 突破 33.5亿 + 价格站稳 → 趋势偏多信号，可关注做多机会；需结合价格突破 $76,500 确认'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-break-3350m-${Date.now()}`;
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
