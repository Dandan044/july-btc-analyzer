/**
 * 主做多入场警报 - $74,750（4小时收盘价确认）
 * 
 * 触发条件：4小时K线收盘价 >= $74,750
 * 报告依据：方案A - 4小时收盘价≥$74,750并企稳，入场$74,800，止损$73,300
 * 
 * ========== 当前状态 ==========
 * 当前价格: ~$74,253 | $74,750距当前价约+$500(+0.67%)
 * 监控: 4小时收盘价是否突破并企稳于$74,750
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const TARGET_PRICE = 74750;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '主做多入场-74750',
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
        alertType: '主做多入场触发',
        significance: '4小时收盘价突破$74,750，方案A做多条件满足',
        recommendation: '入场$74,800，止损$73,300（风险2%），目标$76,500/$77,740'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-long-main-${Date.now()}`;
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
    // 有效期至下一个日报周期（下次分析时重新评估）
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 1 ? 'active' : 'expired';
  }
};
