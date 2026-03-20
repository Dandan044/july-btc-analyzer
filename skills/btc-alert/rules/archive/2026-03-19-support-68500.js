/**
 * 支撑位跌破警报 - $68,500 (关键支撑)
 * 监控 BTC 价格跌破 $68,500
 * $68,000-$69,000是3月低点区域，跌破将测试$65,000
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-19';
const TARGET_PRICE = 68500;
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: '支撑位跌破警报-68500-关键支撑',
  interval: 2 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标: ${TARGET_PRICE}`);
      return ticker.price <= TARGET_PRICE;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      return false;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 10);
      const fgi = await api.getFearGreedIndex(7);
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h, '7d': ticker.change7d },
        volume24h: ticker.volume24h,
        fearGreedIndex: fgi.current,
        klines15m: klines.map(k => ({ time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume })),
        triggerPrice: TARGET_PRICE,
        alertType: '支撑位跌破-关键支撑'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      return { alertTime: new Date().toISOString(), error: error.message };
    }
  },

  async trigger(data) {
    // 发送明确的 spawn 指令，让七月立即 spawn 新会话执行即时分析
    const spawnMessage = `请立即使用 sessions_spawn 工具（agentId="july", mode="run", timeoutSeconds=0）spawn 一个新会话来执行即时分析任务。

任务内容：
${JSON.stringify(data, null, 2)}

执行后只回复"已触发即时分析"即可。`;

    spawn('openclaw', [
      'agent',
      '--agent', 'july',
      '--message', spawnMessage
    ], {
      detached: true,
      stdio: 'ignore'
    });

    console.log(`[警报触发] 已发送即时分析任务: ${data.alertType}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const daysDiff = Math.floor((new Date(today) - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};