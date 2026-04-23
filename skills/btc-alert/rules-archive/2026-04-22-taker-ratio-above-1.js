/**
 * Taker买卖比回升警报
 * 触发条件：BTC Taker买/卖比从低位回升突破 1.0（1H）
 * 触发后：执行即时分析，评估是否确认做多信号
 * 
 * 依据：04-22 10:26报告判断"这轮上涨Taker比率0.989仍<1.0，
 *       多头主导区间尚未确认，突破由空头平仓推动而非新多头主动买入"。
 *       若Taker比率回升至1.0以上，说明市场开始出现主动买入力量（非空头平仓），
 *       是做多信号的关键确认。
 * 
 * 数据源：OKX Taker Volume API（需代理）
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const TAKER_RATIO_THRESHOLD = 1.0;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'Taker买卖比回升警报-1.0',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const proxy = 'http://127.0.0.1:7890';
      const url = 'https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1H&limit=1';
      const result = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${url}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const data = JSON.parse(result);
      if (!data.data || !data.data[0]) return false;

      const row = data.data[0];
      const buyVol = parseFloat(row[1]);
      const sellVol = parseFloat(row[2]);

      if (!buyVol || !sellVol || sellVol === 0) return false;

      const takerRatio = buyVol / sellVol;
      const triggered = takerRatio >= TAKER_RATIO_THRESHOLD;

      console.log(`[警报检查] ${this.name} | Taker买/卖比: ${takerRatio.toFixed(3)} | 阈值: ${TAKER_RATIO_THRESHOLD} | 触发: ${triggered}`);
      return triggered;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const proxy = 'http://127.0.0.1:7890';
      const tickerUrl = 'https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1H&limit=5';
      const tickerResult = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${tickerUrl}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const api = require('../../btc-market-lite/scripts/api');
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1h', 6);

      const data = JSON.parse(tickerResult);
      const rows = data.data || [];

      const takerData = rows.map(r => {
        const ts = parseInt(r[0]);
        const buyVol = parseFloat(r[1]);
        const sellVol = parseFloat(r[2]);
        return {
          time: new Date(ts).toISOString(),
          buyVolume: buyVol,
          sellVolume: sellVol,
          takerRatio: buyVol / sellVol
        };
      });

      const latest = takerData[0] || {};
      const prev = takerData[1] || {};

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        volume24h: ticker.volume24h,
        latestTakerRatio: latest.takerRatio,
        latestHourBuyVolume: latest.buyVolume,
        latestHourSellVolume: latest.sellVolume,
        prevTakerRatio: prev.takerRatio || null,
        takerRatioHistory: takerData.map(d => ({
          time: d.time,
          ratio: d.takerRatio ? d.takerRatio.toFixed(3) : null,
          buyVol: d.buyVolume ? d.buyVolume.toFixed(0) : null,
          sellVol: d.sellVolume ? d.sellVolume.toFixed(0) : null
        })),
        klines1h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        threshold: TAKER_RATIO_THRESHOLD,
        alertType: 'Taker买卖比（非价格）',
        significance: `Taker买/卖比回升至 ${latest.takerRatio ? latest.takerRatio.toFixed(3) : '?'}（阈值1.0）。${latest.takerRatio >= 1.0 ? '市场出现主动买入力量（非空头平仓），是潜在做多信号的关键确认' : '需结合价格方向判断意图'}`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-taker-ratio-${Date.now()}`;
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
