/**
 * ATOM Taker买卖比恢复警报
 * 
 * 来源: alt-report-ATOM-2026-05-13-1245.md
 * 报告观点: "Taker买卖比0.52确认卖压主导，左侧做空"
 * 触发逻辑: 如果Taker买卖比恢复到0.8以上，说明卖压消退，做空逻辑可能失效
 * 当前仓位: 做空14张@2.178
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'ATOM';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const TAKER_THRESHOLD = 0.8;  // Taker买入比恢复阈值
const CONSECUTIVE_REQUIRED = 2;  // 需连续2期确认

module.exports = {
  name: 'ATOM-Taker买卖比恢复',
  interval: 5 * 60 * 1000,  // 5分钟检查
  lastTriggered: 0,
  consecutiveAbove: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取4H K线中的taker ratio数据
      const klines4h = await api.getOKXKlines(COIN, '4H', 3);
      const latestKline = klines4h[klines4h.length - 1];

      // 从OKX Rubik API获取taker买卖比
      const takerResp = await api.fetch(
        `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1D`
      );

      let takerBuyRatio = null;
      if (takerResp && takerResp.data && takerResp.data[0]) {
        const buyVol = parseFloat(takerResp.data[0][2]);  // buyVolume
        const sellVol = parseFloat(takerResp.data[0][3]);  // sellVolume
        if (buyVol + sellVol > 0) {
          takerBuyRatio = buyVol / (buyVol + sellVol);
        }
      }

      if (takerBuyRatio === null) {
        console.log(`[🔍警报检查] [API] ${COIN} Taker数据获取失败 | [进度] ${this.name} | 状态: 数据缺失`);
        return false;
      }

      const currentPrice = latestKline.close;

      if (takerBuyRatio >= TAKER_THRESHOLD) {
        this.consecutiveAbove++;
        console.log(`[🔍警报检查] [API] OKX获取${COIN} Taker数据 | [进度] ${this.name} | Taker买入比: ${takerBuyRatio.toFixed(4)} ≥ ${TAKER_THRESHOLD} | 连续: ${this.consecutiveAbove}/${CONSECUTIVE_REQUIRED} | 当前价: $${currentPrice.toFixed(3)} | 触发: ${this.consecutiveAbove >= CONSECUTIVE_REQUIRED}`);
        return this.consecutiveAbove >= CONSECUTIVE_REQUIRED;
      } else {
        this.consecutiveAbove = 0;
        console.log(`[🔍警报检查] [API] OKX获取${COIN} Taker数据 | [进度] ${this.name} | Taker买入比: ${takerBuyRatio.toFixed(4)} < ${TAKER_THRESHOLD} | 连续重置 | 当前价: $${currentPrice.toFixed(3)} | 触发: false`);
        return false;
      }
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN);
      const klines4h = await api.getOKXKlines(COIN, '4H', 3);

      const takerResp = await api.fetch(
        `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1D`
      );

      let takerBuyRatio = null;
      if (takerResp && takerResp.data && takerResp.data[0]) {
        const buyVol = parseFloat(takerResp.data[0][2]);
        const sellVol = parseFloat(takerResp.data[0][3]);
        if (buyVol + sellVol > 0) {
          takerBuyRatio = buyVol / (buyVol + sellVol);
        }
      }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        triggerType: 'taker_ratio_recovery',
        takerBuyRatio: takerBuyRatio,
        takerThreshold: TAKER_THRESHOLD,
        consecutiveAbove: this.consecutiveAbove,
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines4h: klines4h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: 'Taker买卖比恢复',
        significance: `Taker买入比${takerBuyRatio?.toFixed(4)}恢复至${TAKER_THRESHOLD}以上，连续${this.consecutiveAbove}期确认，卖压消退信号，做空逻辑可能失效`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-taker-recovery-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${COIN}警报触发] Taker买卖比恢复 | 已派发即时分析: ${jobName} | Taker买入比: ${data.takerBuyRatio?.toFixed(4)} | 连续: ${data.consecutiveAbove}期`);

    this.lastTriggered = Date.now();
    this.consecutiveAbove = 0;
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};