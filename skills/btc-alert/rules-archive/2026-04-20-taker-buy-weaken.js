/**
 * Taker买入减弱警报
 * 监控 Taker 买入比率从增强转为减弱
 * 
 * 报告依据：Taker买入比率（主动买入/主动卖出）是实时交易意愿指标。
 * 当比率从高点回落，可能预示短期反弹动能衰竭。
 * 当前价格下跌+OI下降+若Taker买入减弱=空头主导延续。
 * 
 * ========== 监控逻辑 ==========
 * 当Taker买入比率从高位回落超过20%，或比率<0.9时触发
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const TAKER_RATIO_LOW_THRESHOLD = 0.9; // 触发阈值：Taker买入比率低于此值
const TAKER_RATIO_DROP_THRESHOLD = 0.2; // 触发阈值：从高位回落超过此值
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// 记录历史高点
let highestRatio = null;
let highestRatioTime = null;

module.exports = {
  name: 'Taker买入减弱警报',
  interval: 15 * 60 * 1000, // 15分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const takerData = await api.getOKXTakerRatio();
      const currentRatio = takerData.currentRatio;
      
      // 记录最高点（用于检测回落）
      if (highestRatio === null || currentRatio > highestRatio) {
        highestRatio = currentRatio;
        highestRatioTime = Date.now();
        console.log(`[Taker监控] 新高比率: ${currentRatio.toFixed(3)}, 记录时间: ${new Date().toISOString()}`);
      }
      
      console.log(`[警报检查] Taker当前: ${currentRatio.toFixed(3)}, 记录高点: ${highestRatio.toFixed(3)}, 阈值: ${TAKER_RATIO_LOW_THRESHOLD}`);

      // 触发条件1：比率低于阈值（空头主导）
      if (currentRatio <= TAKER_RATIO_LOW_THRESHOLD) {
        console.log(`[触发条件1] Taker比率低于 ${TAKER_RATIO_LOW_THRESHOLD}`);
        return true;
      }
      
      // 触发条件2：从高位回落超过阈值
      if (highestRatio !== null && highestRatio > 1.0) {
        const drop = highestRatio - currentRatio;
        if (drop >= TAKER_RATIO_DROP_THRESHOLD) {
          console.log(`[触发条件2] Taker比率从 ${highestRatio.toFixed(3)} 回落 ${drop.toFixed(3)}`);
          return true;
        }
      }
      
      // 如果当前比率创新高，重置回落追踪
      if (currentRatio > highestRatio) {
        highestRatio = currentRatio;
      }
      
      return false;
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
        takerRatio: {
          current: takerData.currentRatio,
          buyVolume: takerData.buyVolume,
          sellVolume: takerData.sellVolume,
          highestRecent: highestRatio
        },
        openInterest: {
          current: oiData.currentOI,
          change24h: oiData.change24h
        },
        klines4h: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: 'Taker买入减弱',
        significance: 'Taker买入减弱，预示短期反弹动能衰竭，空头主导延续',
        recommendation: '若同时出现价格下跌+OI下降+Taker减弱共振，短期偏空信号增强'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-taker-weaken-${Date.now()}`;
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
    // 重置高点追踪
    highestRatio = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};