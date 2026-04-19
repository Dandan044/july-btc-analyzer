/**
 * 持仓量下降警报 - 资金撤离预警
 * 监控 BTC 持仓量24h下降超过10%
 * 当前判断：04-19持仓量降6%，若继续下降超10%说明资金持续撤离
 *
 * ========== 当前状态 ==========
 * 持仓量: 3,415.9k BTC | 24h变化: -6.05%
 * 监控: 持仓量24h变化 < -10%（资金持续撤离信号）
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-19';
const THRESHOLD_PERCENT = -10; // 触发阈值：下降超过10%
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '持仓量下降警报-超10%',
  interval: 30 * 60 * 1000, // 30分钟检查一次（持仓量更新频率较低）
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      console.log(`[警报检查] 当前持仓量: ${oiData.currentOI}k BTC, 24h变化: ${oiData.change24h}%`);
      
      // 触发条件：持仓量24h下降超过10%
      return oiData.change24h <= THRESHOLD_PERCENT;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const oiData = await api.getOKXOpenInterest();
      const takerData = await api.getOKXTakerRatio();
      const klines = await api.getKlines('BTC', '1h', 6);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: {
          current: oiData.currentOI,
          prev: oiData.prevOI,
          change24h: oiData.change24h,
          history: oiData.history
        },
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume
        },
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '持仓量下降预警',
        significance: '持仓量24h下降超过10%，资金持续撤离，反弹动能不足，可能加速下跌',
        recommendation: '观察价格是否跌破支撑位$74,487：若跌破，考虑提前减仓止损'
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
    // 有效期：最长3天
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};