/**
 * 关键支撑跌破警报 - $77,500
 * 触发条件：BTC 价格跌破 $77,500 并延续（4H收盘低于）
 * 触发后：执行即时分析，评估是否触发做空信号
 * 
 * 依据：04-22 21:51即时分析报告判断"$77,500 是关键支撑1（整数关口，多空分界），
 *       若跌破 $77,500 放量（>$800M）→ 做空，止损 $79,000（+0.6%），止盈 $77,500（-1.4%）。
 *       当前价格 $78,664.6，若 $78,420-$78,963 区间受阻回落，可能测试 $77,500。
 *       跌破 $77,500 将破坏4H上升结构，触发程序化止损。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const TARGET_PRICE = 77500;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '关键支撑跌破警报-77500',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;
      
      // 跌破 $77,500 视为有效跌破
      const triggered = currentPrice < TARGET_PRICE;
      
      console.log(`[🔍警报检查] ${this.name} | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: ${triggered}`);
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines4h = await api.getKlines('BTC', '4h', 5);
      const klines1h = await api.getKlines('BTC', '1h', 6);
      const priceHistory = await api.getPriceHistory('BTC', 7);
      
      // 计算4H成交量均值（用于判断是否放量）
      const avg4hVolume = klines4h.slice(0, 4).reduce((sum, k) => sum + k.volume, 0) / 4;
      const latest4hVolume = klines4h[0]?.volume || 0;
      const volumeRatio = latest4hVolume / avg4hVolume;
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': priceHistory.prices.length > 0 
            ? ((ticker.price - priceHistory.prices[priceHistory.prices.length - 1]) / priceHistory.prices[priceHistory.prices.length - 1] * 100).toFixed(2)
            : null
        },
        volume24h: ticker.volume24h,
        triggerPrice: TARGET_PRICE,
        latest4hVolume: latest4hVolume,
        avg4hVolume: avg4hVolume,
        volumeRatio: volumeRatio.toFixed(2),
        isVolumeSurge: volumeRatio >= 1.5 ? '是（放量）' : '否（缩量）',
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        klines1h: klines1h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '下方价格警报',
        significance: `价格跌破 $${TARGET_PRICE}（关键支撑，多空分界）。${volumeRatio >= 1.5 ? '放量跌破（4H成交量' + (volumeRatio * 100).toFixed(0) + '%均值），做空信号强化' : '缩量跌破，需观察能否延续'}。止损 $79,000（+1.9%），止盈1 $77,500（-1.4%，平仓50%），止盈2 $76,800（-2.3%，平仓剩余）。跌破 $77,500 将破坏4H上升结构，可能触发更深回调。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-77500-${Date.now()}`;
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

    console.log(`[⚡警报触发] ${this.name} | 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};