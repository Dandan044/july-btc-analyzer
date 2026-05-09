/**
 * SAHARA Taker买卖比偏空警报
 * 
 * 监控 SAHARA 合约的 Taker 买卖比
 * 当 Taker 买卖比持续 < 0.85（卖盘占优）且价格在高位时，可能预示顶部
 * 使用 K线序列中附带的 takerRatio 数据
 *
 * 来源: alt-SAHARA-20260509-0404/reports/alt-report-SAHARA-2026-05-09-0408.md
 * 报告观点: 反弹接近阻力位，需警惕买盘动能衰减信号
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'SAHARA';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const TAKER_THRESHOLD = 0.85;   // 低于此值视为偏空
const CONSECUTIVE_CHECKS = 3;   // 连续3次检查均低于阈值才触发

module.exports = {
  name: 'SAHARA Taker买卖比偏空',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,

  // 追踪连续偏空次数
  bearishCount: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 使用1H K线获取最新的 takerRatio
      const klines = await api.getKlines('SAHARA', '1h', 2);
      const latest = klines[klines.length - 1];
      const ticker = await api.getTicker('SAHARA');
      const price = parseFloat(ticker.price);

      let takerRatio = null;
      if (latest && latest.takerRatio !== undefined) {
        takerRatio = parseFloat(latest.takerRatio);
      }

      // 无法获取 takerRatio 时不触发
      if (takerRatio === null || isNaN(takerRatio)) {
        console.log(`[🔍警报检查] [API] OKX获取SAHARA K线+价格 | [进度] ${this.name} | 无Taker比数据，跳过 | 触发: false`);
        return false;
      }

      const isBearish = takerRatio < TAKER_THRESHOLD;

      if (isBearish) {
        this.bearishCount++;
      } else {
        // 重置
        if (this.bearishCount > 0) {
          console.log(`[🔍警报检查] [API] OKX获取SAHARA 1H K线 | [进度] ${this.name} | TakerRatio: ${takerRatio.toFixed(4)} | 恢复中性，重置计数 | 触发: false`);
          this.bearishCount = 0;
        }
      }

      if (this.bearishCount >= CONSECUTIVE_CHECKS) {
        console.log(`[🔍警报检查] [API] OKX获取SAHARA 1H K线 | [进度] ${this.name} | TakerRatio: ${takerRatio.toFixed(4)} | 连续${this.bearishCount}/${CONSECUTIVE_CHECKS}次偏空 | 价格: $${price.toFixed(5)} | 触发: true`);
        return true;
      }

      console.log(`[🔍警报检查] [API] OKX获取SAHARA 1H K线 | [进度] ${this.name} | TakerRatio: ${takerRatio.toFixed(4)} | 连续${this.bearishCount}/${CONSECUTIVE_CHECKS}次偏空 | 触发: false`);

      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('SAHARA');
      const klines1h = await api.getKlines('SAHARA', '1h', 6);

      return {
        coin: 'SAHARA',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,

        takerRatioAnalysis: {
          threshold: TAKER_THRESHOLD,
          consecutiveChecks: CONSECUTIVE_CHECKS,
          bearishCount: this.bearishCount,
          takerRatios: klines1h.map(k => ({
            time: k.datetime,
            ratio: k.takerRatio
          }))
        },

        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines1h: klines1h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

        alertType: 'Taker买卖比偏空',
        significance: `Taker买卖比连续${CONSECUTIVE_CHECKS}次低于${TAKER_THRESHOLD}，卖盘占优，可能预示短期顶部`,
        alertSource: 'SAHARA周期扫描-阶段四'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-SAHARA-taker-${Date.now()}`;
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

    console.log(`[SAHARA警报触发] Taker买卖比偏空警报触发: ${jobName}`);
    this.lastTriggered = Date.now();
    this.bearishCount = 0;
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};
