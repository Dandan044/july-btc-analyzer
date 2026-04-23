/**
 * 非价格警报：持仓量变化警报
 * 监控 BTC 持仓量（OI）4小时内变化超过1.5%
 * 适用场景：OI快速下降往往预示空头获利了结，价格可能企稳；OI上升则可能顺势
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const OI_CHANGE_THRESHOLD = 1.5; // 触发阈值：4h OI变化超过1.5%
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '持仓量变化警报',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取最近2根4H K线的OI数据
      // OKX持仓量通过K线数据的oiQty字段获取
      const klines = await api.getOKXKlines('BTC', '4H', 2);

      if (klines.length < 2) {
        console.log(`[警报检查] K线数据不足，跳过`);
        return false;
      }

      const [latest, previous] = klines;
      const latestOI = parseFloat(latest.oiQty) || 0;
      const previousOI = parseFloat(previous.oiQty) || 0;

      if (!latestOI || !previousOI) {
        console.log(`[警报检查] OI数据异常，跳过: latest=${latestOI}, previous=${previousOI}`);
        return false;
      }

      const oiChangePct = Math.abs((latestOI - previousOI) / previousOI * 100);

      console.log(`[警报检查] 最新OI: ${(latestOI/1e6).toFixed(2)}M, 前值: ${(previousOI/1e6).toFixed(2)}M, 变化: ${oiChangePct.toFixed(2)}%`);

      return oiChangePct >= OI_CHANGE_THRESHOLD;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker('BTC');
      const klines4h = await api.getOKXKlines('BTC', '4H', 4);

      const latestOI = parseFloat(klines4h[0].oiQty) || 0;
      const previousOI = parseFloat(klines4h[1].oiQty) || 0;
      const oiChangePct = previousOI ? ((latestOI - previousOI) / previousOI * 100).toFixed(2) : 'N/A';

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentOI: latestOI,
        previousOI: previousOI,
        oiChangePct: oiChangePct,
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          oiQty: k.oiQty
        })),
        alertType: '持仓量变化',
        significance: `4H OI变化 ${oiChangePct}%，需结合价格方向判断多空意图`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const spawnMessage = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;
    const now = new Date().toISOString();
    const jobName = `alert-oi-${Date.now()}`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--session', 'isolated',
      '--at', now,
      '--message', spawnMessage,
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
