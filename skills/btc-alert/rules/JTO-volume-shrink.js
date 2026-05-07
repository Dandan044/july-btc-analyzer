/**
 * JTO 成交量萎缩警报
 * 监控JTO-USDT-SWAP的4H成交量是否持续萎缩
 * 触发条件：最近2个4H周期成交量均 < 7日均量的30%
 * → 催化剂动能衰减，需要重新评估趋势持续性
 *
 * 来源：active/alt-JTO-20260507-0104/reports/alt-report-JTO-2026-05-07-0110.md
 * 报告观点：JTX催化剂后成交量爆炸(5/6 $35.89M)，若持续缩量则动能衰减
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'JTO';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 2 * 60 * 60 * 1000;  // 成交量警报冷却2小时
const COIN = 'JTO';
const PROXY_URL = 'http://127.0.0.1:7890';

const VOLUME_SHRINK_RATIO = 0.30;  // 成交量 < 7日均量30% → 异常萎缩
const SUSTAINED_PERIODS = 2;        // 连续2个4H周期确认

module.exports = {
  name: 'JTO-成交量萎缩',
  interval: 10 * 60 * 1000,  // 每10分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取4H K线（最近7天 ≈ 42根4H，取足够计算均量）
      const url = `https://www.okx.com/api/v5/market/candles?instId=${COIN}-USDT-SWAP&bar=4H&limit=42`;
      const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, {
        encoding: 'utf8', timeout: 20000
      });
      const resp = JSON.parse(result);

      if (resp.code !== '0' || !resp.data || resp.data.length < 10) {
        console.log(`[🔍JTO-Vol] 数据不足，跳过`);
        return false;
      }

      // OKX K线格式: [ts, open, high, low, close, vol, volCcy]
      const candles = resp.data.slice(0, 42).map(c => ({
        time: new Date(parseInt(c[0])).toISOString(),
        volume: parseFloat(c[5]),
        volumeCcy: parseFloat(c[6])
      }));

      // 计算7日均量（最近7天=约42根4H K线）
      const avgVolume7d = candles.reduce((sum, c) => sum + c.volumeCcy, 0) / candles.length;

      // 最近N个周期成交量
      const recentVolumes = candles.slice(0, SUSTAINED_PERIODS);
      const recentAvg = recentVolumes.reduce((sum, c) => sum + c.volumeCcy, 0) / SUSTAINED_PERIODS;
      const ratio = recentAvg / avgVolume7d;

      console.log(`[🔍JTO-Vol] 7日4H均量: $${(avgVolume7d/1000000).toFixed(2)}M | 最近${SUSTAINED_PERIODS}个4H均量: $${(recentAvg/1000000).toFixed(2)}M | 比例: ${(ratio*100).toFixed(1)}% | 阈值: <${VOLUME_SHRINK_RATIO*100}%`);

      // 检查是否持续低于阈值
      const allShrunk = recentVolumes.every(c => c.volumeCcy < avgVolume7d * VOLUME_SHRINK_RATIO);

      if (allShrunk && ratio < VOLUME_SHRINK_RATIO) {
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌JTO-Vol错误]', error.message);
      return false;
    }
  },

  async collect() {
    try {
      const url = `https://www.okx.com/api/v5/market/candles?instId=${COIN}-USDT-SWAP&bar=4H&limit=42`;
      const result = execSync(`curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`, {
        encoding: 'utf8', timeout: 20000
      });
      const resp = JSON.parse(result);
      const candles = resp.data.slice(0, 42).map(c => ({
        time: new Date(parseInt(c[0])).toISOString(),
        volume: parseFloat(c[5]),
        volumeCcy: parseFloat(c[6])
      }));

      const avgVolume7d = candles.reduce((sum, c) => sum + c.volumeCcy, 0) / candles.length;
      const recentVolumes = candles.slice(0, SUSTAINED_PERIODS);
      const recentAvg = recentVolumes.reduce((sum, c) => sum + c.volumeCcy, 0) / SUSTAINED_PERIODS;

      // 获取当前价格
      const tickerUrl = `https://www.okx.com/api/v5/market/ticker?instId=${COIN}-USDT-SWAP`;
      const tickerResult = execSync(`curl -s --max-time 10 --proxy "${PROXY_URL}" "${tickerUrl}"`, {
        encoding: 'utf8', timeout: 15000
      });
      const tickerData = JSON.parse(tickerResult);
      const lastPrice = parseFloat(tickerData.data[0].last);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: lastPrice,
        volume7dAvg: parseFloat(avgVolume7d.toFixed(2)),
        volume7dAvgFormatted: `$${(avgVolume7d/1000000).toFixed(2)}M`,
        recentAvg: parseFloat(recentAvg.toFixed(2)),
        recentAvgFormatted: `$${(recentAvg/1000000).toFixed(2)}M`,
        shrinkRatio: parseFloat((recentAvg / avgVolume7d * 100).toFixed(1)),
        recent4h: recentVolumes.map(c => ({
          time: c.time,
          volumeCcy: c.volumeCcy,
          volumeFormatted: `$${(c.volumeCcy/1000000).toFixed(2)}M`
        })),
        signal: `成交量持续萎缩至7日均量的${(recentAvg/avgVolume7d*100).toFixed(1)}%，JTX催化剂动能可能衰减，需重新评估趋势持续性`,
        alertType: 'JTO-成交量萎缩'
      };
    } catch (error) {
      console.error('[❌JTO-Vol数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-${data.coin}-vol-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [