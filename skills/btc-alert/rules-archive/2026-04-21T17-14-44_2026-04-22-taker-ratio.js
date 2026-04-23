/**
 * 非价格警报：Taker买卖比异常警报
 * 监控 BTC Taker买卖比异常偏离（从<1转为>1.1，或从>1转为<0.9）
 * 适用场景：Taker买卖比反映主动买卖力量，偏离往往预示短期方向选择
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const TAKER_THRESHOLD_HIGH = 1.1;  // 做多信号阈值
const TAKER_THRESHOLD_LOW = 0.9;   // 做空信号阈值
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'Taker买卖比异常警报',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,
  lastTakerState: null,  // 记录上次的Taker状态

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取OKX Taker买卖数据
      const url = 'https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D';
      const data = await api.fetch(url);

      if (!data.data || !data.data[0]) {
        console.log(`[警报检查] Taker数据获取失败`);
        return false;
      }

      // data[0] 格式：[ts, buyVol(主动买入量), sellVol(主动卖出量), buyVolCcy, sellVolCcy]
      const takerData = data.data[0];
      const buyVol = parseFloat(takerData[1]) || 0;
      const sellVol = parseFloat(takerData[2]) || 0;

      if (!buyVol || !sellVol) {
        console.log(`[警报检查] Taker数据异常，买入=${buyVol}, 卖出=${sellVol}`);
        return false;
      }

      const takerRatio = buyVol / sellVol;
      const prevState = this.lastTakerState;
      this.lastTakerState = takerRatio >= TAKER_THRESHOLD_HIGH ? 'long' : (takerRatio <= TAKER_THRESHOLD_LOW ? 'short' : 'neutral');

      console.log(`[警报检查] Taker买卖比: ${takerRatio.toFixed(3)}, 状态: ${this.lastTakerState}`);

      // 触发条件：从做空区域进入做多区域，或反之
      if (prevState === 'long' && takerRatio <= TAKER_THRESHOLD_LOW) {
        console.log(`[警报检查] Taker比从多头区反转为空头区，触发警报`);
        return true;
      }
      if (prevState === 'short' && takerRatio >= TAKER_THRESHOLD_HIGH) {
        console.log(`[警报检查] Taker比从空头区反转为多头区，触发警报`);
        return true;
      }

      // 新规则首次触发：从neutral直接进入极端区域
      if (!prevState && (takerRatio >= TAKER_THRESHOLD_HIGH || takerRatio <= TAKER_THRESHOLD_LOW)) {
        // 首次只有极端值才触发
        return takerRatio >= TAKER_THRESHOLD_HIGH * 1.15 || takerRatio <= TAKER_THRESHOLD_LOW / 1.15;
      }

      return false;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('BTC');
      const url = 'https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=BTC-USDT-SWAP&instType=CONTRACTS&ccy=BTC&period=1D';
      const data = await api.fetch(url);

      let takerRatio = null;
      let buyVol = 0, sellVol = 0;

      if (data.data && data.data[0]) {
        const takerData = data.data[0];
        buyVol = parseFloat(takerData[1]) || 0;
        sellVol = parseFloat(takerData[2]) || 0;
        takerRatio = buyVol / sellVol;
      }

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        takerRatio: takerRatio ? takerRatio.toFixed(3) : 'N/A',
        buyVolume: buyVol,
        sellVolume: sellVol,
        alertType: 'Taker买卖比异常',
        significance: `Taker买卖比从极端区反转，信号多空力量转换，需关注短期方向`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const spawnMessage = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;
    const now = new Date().toISOString();
    const jobName = `alert-taker-${Date.now()}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', spawnMessage,
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
