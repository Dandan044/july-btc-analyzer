/**
 * 警报规则：$67,500阻力突破
 * 来源：instant-report-2026-03-31-0123
 * 意义：前支撑转阻力，入场做空参考
 */

const ALERT_NAME = 'resistance-67500';
const TARGET_PRICE = 67500;
const DIRECTION = 'up'; // 向上突破

module.exports = {
  name: ALERT_NAME,

  // 获取规则元数据
  meta() {
    return {
      name: ALERT_NAME,
      target: TARGET_PRICE,
      direction: DIRECTION,
      description: `$67,500阻力突破（前支撑转阻力，入场做空参考）`,
      createdAt: '2026-03-31T01:27:00+08:00',
      source: 'instant-report-2026-03-31-0123'
    };
  },

  // 判断规则是否存活
  lifetime() {
    // 价格已远离目标时失效
    const ticker = this.getTicker();
    if (!ticker) return 'active';
    
    const currentPrice = ticker.last;
    const distance = Math.abs(currentPrice - TARGET_PRICE) / TARGET_PRICE;
    
    // 若价格距离超过5%，且方向相反，则失效
    if (distance > 0.05) {
      if (DIRECTION === 'up' && currentPrice < TARGET_PRICE * 0.95) {
        return 'expired';
      }
      if (DIRECTION === 'down' && currentPrice > TARGET_PRICE * 1.05) {
        return 'expired';
      }
    }
    
    // 7天后自动过期
    const createdAt = new Date('2026-03-31T01:27:00+08:00');
    const now = new Date();
    const daysPassed = (now - createdAt) / (1000 * 60 * 60 * 24);
    if (daysPassed > 7) return 'expired';
    
    return 'active';
  },

  // 收集市场数据
  collect() {
    const ticker = this.getTicker();
    const klines15m = this.getKlines('15m', 6);
    
    return {
      currentPrice: ticker?.last || 0,
      priceChange: {
        '1h': ticker?.priceChangePercent1h || '0',
        '24h': ticker?.priceChangePercent24h || '0',
        '7d': ticker?.priceChangePercent7d || '0'
      },
      volume24h: ticker?.volume24h || 0,
      klines15m: klines15m || []
    };
  },

  // 判断是否触发
  evaluate(data) {
    const { currentPrice, klines15m } = data;
    
    // 价格突破目标
    if (currentPrice >= TARGET_PRICE) {
      // 检查是否有放量
      const lastKline = klines15m[klines15m.length - 1] || {};
      const avgVolume = klines15m.reduce((sum, k) => sum + (k.volume || 0), 0) / klines15m.length;
      const hasVolume = (lastKline.volume || 0) > avgVolume * 1.5;
      
      return {
        triggered: true,
        significance: `价格突破$67,500阻力（前支撑转阻力）。${hasVolume ? '伴随放量，突破有效。' : '突破未放量，需观察持续性。'}这是做空入场参考位置。`
      };
    }
    
    return { triggered: false };
  },

  // 触发后的动作
  async action(data, result) {
    // 发送到七月执行即时分析
    await this.sendToAgent('july', {
      alertName: ALERT_NAME,
      alertType: 'resistance_breakthrough',
      triggerTime: new Date().toISOString(),
      targetPrice: TARGET_PRICE,
      ...data,
      message: result.significance
    });
  },

  // 获取API数据的方法（由警报器引擎注入）
  getTicker: null,
  getKlines: null,
  sendToAgent: null
};