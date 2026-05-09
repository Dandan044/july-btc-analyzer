/**
 * NOT (Notcoin) Taker买卖比异常监控警报
 * 监控Taker买卖比是否异常偏高（持续>1.3）或偏低（持续<0.8）
 * 当前做空状态，高taker比=主动买盘强劲=短空风险信号
 * 低taker比=主动卖盘强劲=做空方向确认
 *
 * 来源: alt-report-NOT-2026-05-09-1020.md
 * 报告观点: "Taker比1.55说明下跌中仍有活跃买盘，需警惕反转"
 * 创建日期: 2026-05-09
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const CREATED_DATE = '2026-05-09';
const COIN = 'NOT';
const COOLDOWN_MS = 60 * 60 * 1000;

// 阈值配置
const UPPER_THRESHOLD = 1.3;  // Taker比 > 1.3 = strong buying
const LOWER_THRESHOLD = 0.8;  // Taker比 < 0.8 = strong selling

module.exports = {
  name: 'NOT-Taker买卖比异常',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取1小时Taker买卖比数据（OKX Rubik API，period=1H）
      const takerData = await api.getOKXTakerRatio(COIN);
      
      if (!takerData || !takerData.values || takerData.values.length === 0) {
        return false;
      }

      const latestTakerRatio = takerData.values[takerData.values.length - 1];
      const triggered = latestTakerRatio > UPPER_THRESHOLD || latestTakerRatio < LOWER_THRESHOLD;

      const direction = latestTakerRatio > UPPER_THRESHOLD ? '🔥强买方主导' : 
                        latestTakerRatio < LOWER_THRESHOLD ? '🧊强卖方主导' : '正常';

      console.log(`[🔍警报检查] [API] OKX获取${COIN}Taker买卖比(1H) | [进度] ${this.name} | 当前比: ${latestTakerRatio.toFixed(4)} | 上阈值: ${UPPER_THRESHOLD} | 下阈值: ${LOWER_THRESHOLD} | 状态: ${direction} | 触发: ${triggered} | [来源] 05-09 10:20即时分析: "Taker比1.55异常偏买，需警惕反转"`);

      return triggered;
    } catch (error) {
      console.error(`[❌${COIN}Taker警报错误]`, error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const takerData = await api.getOKXTakerRatio(COIN);
      const klines15m = await api.getOKXKlines(COIN, '15m', 6, 'SWAP');
      
      let oiData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
      } catch (e) { /* 可选 */ }

      const latestRatio = takerData?.values?.length > 0 ? takerData.values[takerData.values.length - 1] : null;

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        takerRatio: latestRatio,
        takerHistory: takerData?.values?.slice(-6) || [],
        openInterest: oiData?.currentOI,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: 'NOT-Taker买卖比异常',
        significance: latestRatio > UPPER_THRESHOLD
          ? `Taker比(${latestRatio.toFixed(4)})超过上阈值(${UPPER_THRESHOLD})，主动买盘异常强劲，空头需警惕`
          : `Taker比(${latestRatio.toFixed(4)})低于下阈值(${LOWER_THRESHOLD})，主动卖盘异常强劲，做空方向确认`
      };
    } catch (error) {
      console.error(`[❌${COIN}Taker数据收集错误]`, error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-taker-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.altcoin.model;
    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', model,
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${COIN}Taker警报触发] 已派发即时分析: ${jobName} | Taker比: ${alertData.takerRatio}`);

    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
