/**
 * 阻力位突破警报 - $70,000 (原支撑转阻力)
 * 监控 BTC 价格反弹至 $70,000
 * $70,000 原为支撑位，现已转为阻力
 * 若反弹至此区域遇阻，可考虑做空
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-19';
const TARGET_PRICE = 70000;
const COOLDOWN_MS = 60 * 60 * 1000;

module.exports = {
  name: '阻力位测试警报-70000-原支撑转阻力',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    try {
      const ticker = await api.getTicker('BTC');
      console.log(`[警报检查] 当前价格: ${ticker.price}, 目标: ${TARGET_PRICE}`);
      return ticker.price >= TARGET_PRICE;
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
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': ticker.change7d
        },
        volume24h: ticker.volume24h,
        fearGreedIndex: fgi.current,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        triggerPrice: TARGET_PRICE,
        alertType: '阻力位测试-原支撑转阻力'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      return { alertTime: new Date().toISOString(), error: error.message };
    }
  },

  async trigger(data) {
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
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 2 ? 'active' : 'expired';
  }
};