/**
 * 下方支撑跌破警报
 * 监控 BTC 价格跌破 $73,834（4H 38.2% 斐波回撤位，强支撑）
 *
 * 报告依据：$73,834 是 4H 波段 38.2% 斐波回撤位，距离当前价格 $1,599，
 * 是更重要的支撑区域。若 4H 收盘跌破 $73,834，空头将主导，
 * 下降结构延续（路径二，概率 35%）。
 *
 * ========== 监控逻辑 ==========
 * 价格跌破 $73,834（立即触发，非延迟）
 * 触发条件：跌破后观察是否持续，确认有效跌破
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-21';
const TARGET_PRICE = 73834; // 4H 38.2% 斐波回撤位
const COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2小时冷却

module.exports = {
  name: '下方支撑跌破-73834',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      const price = ticker.price;

      console.log(`[警报检查] 当前价格: ${price}, 目标: ${TARGET_PRICE}`);

      return price < TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '4h', 6);
      const oiData = await api.getOKXOpenInterest();

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        targetPrice: TARGET_PRICE,
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
        alertType: '下方支撑跌破',
        significance: '跌破 $73,834 代表空头主导，下降结构延续',
        recommendation: '空头思路对待，可考虑做空或等待反弹做空'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-break-${Date.now()}`;
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
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
