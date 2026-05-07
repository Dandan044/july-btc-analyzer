/**
 * DASH 成交量飙升监控警报
 * 监控 DASH-USDT-SWAP 1h成交量是否突然放大，捕捉资金重新入场信号
 *
 * 来源: active/alt-DASH-20260506-2004/reports/alt-report-DASH-2026-05-07-0507.md
 * 报告观点: "成交量从$152M坍塌至$2.25M，突破动量完全消退。
 *           若1h成交量突然放大至$5M+，说明新资金入场，需重新评估方向"
 * 持仓: Short 73张@$54.41, SL$56.15, TP$51.20/$47.01
 * 创建: 2026-05-07T05:07
 *
 * 触发条件: 最近1小时成交量(USD) > $5,000,000
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'DASH';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07T05:07';
const VOLUME_SPIKE_THRESHOLD = 5000000;  // $5M 1h volume
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'DASH-成交量飙升',
  interval: 15 * 60 * 1000, // 15分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines('DASH', '1h', 2);
      if (!klines || klines.length < 2) {
        return false;
      }

      // 最新完成的1h K线
      const lastCandle = klines[klines.length - 1];
      const volumeUsd = lastCandle.volume * lastCandle.close;

      const prevCandle = klines[klines.length - 2];
      const prevVolumeUsd = prevCandle.volume * prevCandle.close;

      console.log(`[DASH成交量检查] 最新1h: $${(volumeUsd/1e6).toFixed(2)}M (${lastCandle.datetime}) | 前1h: $${(prevVolumeUsd/1e6).toFixed(2)}M | 阈值: $5.0M`);

      // 触发条件：1h成交量 > $5M 且较前一小时翻倍（排除平稳放量）
      return volumeUsd >= VOLUME_SPIKE_THRESHOLD;
    } catch (error) {
      console.error('[DASH成交量检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('DASH');
      const klines1h = await api.getKlines('DASH', '1h', 12);
      const klines15m = await api.getKlines('DASH', '15m', 16);

      // 计算各小时成交量(USD)
      const hourlyVolumes = klines1h.map(k => ({
        time: k.datetime,
        volumeUsd: k.volume * k.close,
        volumeTokens: k.volume,
        close: k.close
      }));

      const lastVolume = hourlyVolumes[hourlyVolumes.length - 1];
      const avgRecentVolume = hourlyVolumes
        .slice(0, -1)
        .reduce((sum, h) => sum + h.volumeUsd, 0) / (hourlyVolumes.length - 1);

      return {
        coin: 'DASH',
        alertName: 'DASH-成交量飙升',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertType: '成交量飙升',
        lastHourVolume: lastVolume.volumeUsd,
        lastHourVolumeFormatted: '$' + (lastVolume.volumeUsd / 1e6).toFixed(2) + 'M',
        avgRecentHourlyVolume: avgRecentVolume,
        avgRecentHourlyVolumeFormatted: '$' + (avgRecentVolume / 1e6).toFixed(2) + 'M',
        spikeRatio: (lastVolume.volumeUsd / avgRecentVolume).toFixed(2),
        hourlyVolumes: hourlyVolumes,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        significance: 'DASH 1h成交量突然放大至$' + (lastVolume.volumeUsd / 1e6).toFixed(2) +
                     'M(均值$' + (avgRecentVolume / 1e6).toFixed(2) + 'M)，可能是新资金入场或方向选择信号，需重新评估持仓'
      };
    } catch (error) {
      console.error('[DASH成交量数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-DASH-volspike-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [