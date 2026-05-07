/**
 * WIF 成交量异动警报 v1
 * 监控1H成交量是否异常放大（>3x近4H均值）
 * 当前市场成交量极度萎缩，异常放量可能预示方向选择
 *
 * 来源：active/alt-WIF-20260507-0405/reports/alt-report-WIF-20260507-0745.md
 * 报告观点：成交量极度萎缩意味着任何稍大的买卖单都可能引发剧烈波动
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'WIF';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const COIN = 'WIF';
const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000;
const VOLUME_THRESHOLD = 3.0; // 3x 近4H均值

module.exports = {
  name: 'WIF成交量异动v1',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines(COIN, '1h', 8);
      if (klines.length < 5) return false;

      const latest = klines[klines.length - 1];
      const recent4 = klines.slice(-5, -1); // 前4根（不含最新）
      const avgVol = recent4.reduce((s, k) => s + k.volume, 0) / recent4.length;

      if (avgVol <= 0) return false;

      const ratio = latest.volume / avgVol;
      console.log(`[🔍WIF量能] [API] OKX获取${COIN}-USDT-SWAP 1hK线 | 最新量: $${(latest.volume).toFixed(0)} | 近4H均值: $${avgVol.toFixed(0)} | 比值: ${ratio.toFixed(2)}x | 阈值: ${VOLUME_THRESHOLD}x`);

      return ratio >= VOLUME_THRESHOLD;
    } catch (error) {
      console.error('[❌WIF量能错误]', error.message);
      throw error;
    }
  },

  async collect() {
    const klines = await api.getKlines(COIN, '1h', 8);
    const latest = klines[klines.length - 1];
    const recent4 = klines.slice(-5, -1);
    const avgVol = recent4.reduce((s, k) => s + k.volume, 0) / recent4.length;
    const ratio = latest.volume / avgVol;

    const ticker = await api.getOKXTicker(COIN);
    const price = ticker.price;

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      alertType: 'volume_spike',
      currentPrice: price,
      volume: {
        latest: latest.volume,
        avg4h: avgVol,
        ratio: ratio,
        candleTime: latest.datetime
      },
      significance: `成交量${ratio.toFixed(1)}x异常放大，可能预示方向选择`,
      direction: latest.close > latest.open ? 'bullish_candle' : 'bearish_candle'
    };
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${alertData.coin}-vol-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [