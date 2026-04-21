/**
 * 第一止盈位触发警报 - $76,500
 * 
 * 触发条件：4小时K线收盘价 >= $76,500
 * 持仓背景：方案A做多，入场$74,800，止损$73,300，目标$76,500/$77,740
 * 
 * ========== 当前状态 ==========
 * 当前价格: ~$74,942 | $76,500距当前约+$1,558(+2.1%)
 * 监控: 第一止盈位$76,500是否到达（届时需分析是否减仓）
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const TARGET_PRICE = 76500;
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却（止盈后分析频率降低）

module.exports = {
  name: '第一止盈位-76500',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取最新4小时K线
      const klines = await api.getKlines('BTC', '4h', 2);
      if (!klines || klines.length < 2) {
        return false;
      }

      const lastKline = klines[klines.length - 1];
      const price = lastKline.close;
      console.log(`[警报检查] 4h收盘价: ${price}, 目标: ${TARGET_PRICE}`);

      // 触发条件：4小时收盘价 >= 目标价
      return price >= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '4h', 4);
      const takerData = await api.getOKXTakerRatio();
      const oiData = await api.getOKXOpenInterest();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        triggerPrice: TARGET_PRICE,
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        alertType: '第一止盈位触发',
        significance: '价格到达$76,500，第一档止盈位，建议分析是否减仓25%',
        recommendation: '到达$76,500时建议减仓25%（0.5 BTC），止损上移至$75,000'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-tp1-${Date.now()}`;
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
    // 有效期至方案A持仓结束（止盈/止损触发）
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired'; // 有效期3天
  }
};
