/**
 * OI持仓量预警警报
 * 监控 OKX BTC 永续合约持仓量跌破 $3,600M
 * OI下降 = 多头平仓离场确认，为情景C（多杀多踩踏）的领先信号
 * 来源: 04-23 09:05日报 - "OI能否维持在\$3,600M以上是关键"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-23';
const OI_THRESHOLD = 3600000000; // $3,600M = 36亿美元
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'OI持仓量预警-\$3600M',
  interval: 5 * 60 * 1000, // 5分钟检查（OI为日级数据，适当降低频率）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      const currentOI = oiData.currentOI;
      const triggered = currentOI < OI_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取BTC永续合约持仓量 | [进度] ${this.name} | 当前OI: $${(currentOI/1e9).toFixed(3)}B | 阈值: $${(OI_THRESHOLD/1e9).toFixed(1)}B | 触发: ${triggered} | 24h变化: ${oiData.change24h.toFixed(2)}% | [来源] 04-23 09:05日报: "OI能否维持在\$3,600M以上是关键指标，若快速下降至\$3,500M以下→多头平仓离场确认"`);

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
      const klines4h = await api.getOKXKlines ? await api.getOKXKlines('BTC-USDT-SWAP', '4h', 4) : [];
      const klines15m = await api.getKlines('BTC', '15m', 8);

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        openInterest: oiData.currentOI,
        openInterestPrev: oiData.prevOI,
        openInterestChange24h: oiData.change24h,
        oiThreshold: OI_THRESHOLD,
        takerBuyRatio: takerData.currentRatio,
        klines4h: klines4h.length > 0 ? klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })) : undefined,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: 'OI持仓量预警',
        significance: 'OI跌破\$3,600M说明多头平仓加速，为情景C（多杀多踩踏）的领先确认信号'
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
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
