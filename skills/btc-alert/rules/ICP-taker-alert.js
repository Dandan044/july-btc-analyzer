/**
 * ICP Taker买卖比异动警报
 * 监控 ICP 合约主动买卖力量变化——当Taker买方占比显著回升时触发
 *
 * 报告指出Taker买卖比持续走低(0.74)是最大隐忧，主动卖单多于买单。
 * 若Taker比回升至1.2+，表示真实买盘回归，趋势健康度改善。
 *
 * 来源: active/alt-ICP-20260507-0704/reports/alt-report-ICP-2026-05-07-0710.md
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'ICP';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const COIN = 'ICP';
const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却
const TAKER_RATIO_THRESHOLD = 1.2; // Taker买/卖 > 1.2 = 主动买方显著占优

module.exports = {
  name: 'ICP-Taker买卖比异动',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取最近1小时的Taker买卖数据（period=1H获取小时级聚合）
      const url = `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1H`;
      const data = await api.fetch(url);
      
      if (data.code !== '0') {
        console.error(`[ICP Taker] API错误: ${data.msg}`);
        return false;
      }

      // 最新一小时数据: [ts, buyVol, sellVol]
      const latest = data.data[0];
      const buyVol = parseFloat(latest[1]);
      const sellVol = parseFloat(latest[2]);
      const ratio = buyVol / (sellVol || 1);
      
      // 同时获取前一小时作对比
      const prev = data.data[1];
      const prevBuyVol = parseFloat(prev[1]);
      const prevSellVol = parseFloat(prev[2]);
      const prevRatio = prevBuyVol / (prevSellVol || 1);

      const triggered = ratio >= TAKER_RATIO_THRESHOLD;

      console.log(`[🔍ICP检查] [API] OKX获取ICP Taker买卖比 | [进度] ${this.name} | 当前比: ${ratio.toFixed(2)} (buy:${(buyVol/1000).toFixed(0)}K/sell:${(sellVol/1000).toFixed(0)}K) | 前值: ${prevRatio.toFixed(2)} | 阈值: ${TAKER_RATIO_THRESHOLD} | 触发: ${triggered} | [来源] 05-07 ICP日报: "Taker比0.74是最大隐忧，若回升至1.0+表示真实买盘回归"`);

      return triggered;
    } catch (error) {
      console.error('[❌ICP Taker检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const url = `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1H`;
      const raw = await api.fetch(url);
      
      const ticker = await api.getOKXTicker(COIN);
      const klines15m = await api.getOKXKlines(COIN, '15m', 8);

      const history = (raw.data || []).slice(0, 6).map(d => ({
        time: new Date(parseInt(d[0])).toISOString(),
        buyVol: parseFloat(d[1]),
        sellVol: parseFloat(d[2]),
        ratio: parseFloat((parseFloat(d[1]) / parseFloat(d[2])).toFixed(3))
      }));

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        takerRatio: history[0]?.ratio || 0,
        takerHistory: history,
        threshold: TAKER_RATIO_THRESHOLD,
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        alertType: 'ICP Taker买卖比异动',
        significance: `ICP Taker买方占比回升至${history[0]?.ratio?.toFixed(2)}（阈值${TAKER_RATIO_THRESHOLD}），主动买盘回归，趋势健康度改善`
      };
    } catch (error) {
      console.error('[❌ICP Taker数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-icp-taker-${Date.now()}`;
    const json = JSON.stringify(data);
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [