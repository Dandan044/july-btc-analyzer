/**
 * BILL 成交量异动警报
 * 
 * 来源：active/alt-BILL-20260507-1104/reports/alt-report-BILL-2026-05-07-1108.md
 * 报告观点：BILL二次拉涨量能萎缩66%（$54.8M→$18.7M），若4H量能持续< $10M则买方动能衰竭；
 *           若4H量能>$20M伴随阳线则多头重燃。当前24H成交$134.76M。
 * 创建日期：2026-05-07
 * 
 * 触发条件：
 *   - 24H成交量 < $30M（兴趣消退，从~$135M大幅萎缩）
 *   - 或 24H成交量 > $200M（异常放大，可能新催化剂）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');

const COIN = 'BILL';
const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000;
const VOLUME_LOW_THRESHOLD = 30000000;   // $30M - 买方动能衰竭
const VOLUME_HIGH_THRESHOLD = 200000000; // $200M - 异常放大/新催化剂

module.exports = {
  name: 'BILL成交量异动监控',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      if (!ticker || !ticker.volume24h) {
        console.log('[🔍BILL成交量] 获取ticker失败，跳过检查');
        return false;
      }

      const vol24h = ticker.volume24h;
      const volM = (vol24h / 1e6).toFixed(1);

      if (vol24h < VOLUME_LOW_THRESHOLD) {
        console.log(`[🔍BILL成交量] [API] OKX获取${COIN}永续合约Ticker | [进度] ${this.name} | 24H量: $${volM}M | 阈值: <$30M | 触发: true (兴趣消退) | [来源] 05-07 11:08报告: "二次拉涨量能-66%，若持续萎缩则买方衰竭"`);
        this.triggerReason = 'volume_low';
        return true;
      }

      if (vol24h > VOLUME_HIGH_THRESHOLD) {
        console.log(`[🔍BILL成交量] [API] OKX获取${COIN}永续合约Ticker | [进度] ${this.name} | 24H量: $${volM}M | 阈值: >$200M | 触发: true (异常放大) | [来源] 05-07 11:08报告: "若量能放大至$20M+/4H则多头重燃"`);
        this.triggerReason = 'volume_high';
        return true;
      }

      console.log(`[🔍BILL成交量] [API] OKX获取${COIN}永续合约Ticker | [进度] ${this.name} | 24H量: $${volM}M | 正常范围 | 触发: false | [来源] 05-07 11:08报告`);
      return false;
    } catch (error) {
      console.error('[❌BILL成交量错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines1h = await api.getOKXKlines(COIN, '1H', 6, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4H', 4, 'SWAP');

      // 计算4H累计成交量
      const last4hVol = klines4h.length > 0 
        ? klines4h[klines4h.length - 1].volume 
        : null;

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: '成交量异动',
        triggerReason: this.triggerReason,
        currentPrice: ticker.price,
        volume24h: ticker.volume24h,
        volume24hFormatted: `$${(ticker.volume24h / 1e6).toFixed(1)}M`,
        priceChange24h: ticker.change24h,
        last4hVolume: last4hVol,
        significance: this.triggerReason === 'volume_low'
          ? `BILL 24H成交量萎缩至$${(ticker.volume24h / 1e6).toFixed(1)}M（< $30M），买方动能显著衰竭，需重新评估方向`
          : `BILL 24H成交量异常放大至$${(ticker.volume24h / 1e6).toFixed(1)}M（> $200M），可能有大资金介入或新交易所/消息催化`,
        klines1h: klines1h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        klines4h: klines4h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        }))
      };
    } catch (error) {
      console.error('[❌BILL成交量数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-volume-${Date.now()}`;
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
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[${COIN}成交量警报触发] 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
