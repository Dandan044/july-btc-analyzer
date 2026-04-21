/**
 * 阻力位突破警报
 * 监控 BTC 价格突破 $75,500 关键阻力
 * 
 * 报告依据：$75,500 是4小时近期反弹高点（75,625→75,364→75,154逐步降低），
 * 若能以大阳线突破并站稳，短期下降趋势可能改变。
 * 当前偏空操作，突破后做多触发。
 * 
 * ========== 当前状态 ==========
 * 当前价格: $75,167
 * 目标位: $75,500（4小时反弹高点）
 * 距离: +$333
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-20';
const TARGET_PRICE = 75500;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '阻力位突破警报-75500',
  interval: 3 * 60 * 1000, // 3分钟检查一次
  lastTriggered: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标突破: ${TARGET_PRICE}`);
      return ticker.price >= TARGET_PRICE;
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
        triggerPrice: TARGET_PRICE,
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
        alertType: '阻力位突破',
        message: '价格突破 $75,500，观察是否站稳',
        significance: '突破后若站稳，可考虑做多；但当前FGI=29（恐惧），非趋势起点特征，需谨慎'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-${Date.now()}`;
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