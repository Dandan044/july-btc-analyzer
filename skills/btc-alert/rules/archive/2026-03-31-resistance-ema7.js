/**
 * 警报规则：EMA7阻力突破
 * 来源：btc-report-2026-03-31-0900
 * 意义：pending做空建议的入场信号确认位置
 */

const ALERT_NAME = 'resistance-ema7';
const TARGET_PRICE = 67485; // EMA7动态值，实际检查时需要获取最新EMA7
const DIRECTION = 'up'; // 向上突破

module.exports = {
  name: ALERT_NAME,

  // 获取规则元数据
  meta() {
    return {
      name: ALERT_NAME,
      target: 'EMA7(~$67,485)',
      direction: DIRECTION,
      description: `EMA7阻力突破（pending做空入场信号确认）`,
      createdAt: '2026-03-31T09:02:00+08:00',
      source: 'btc-report-2026-03-31-0900'
    };
  },

  // 判断规则是否存活
  lifetime() {
    // pending建议关闭后失效
    // 7天后自动过期
    const createdAt = new Date('2026-03-31T09:02:00+08:00');
    const now = new Date();
    const daysPassed = (now - createdAt) / (1000 * 60 * 60 * 24);
    if (daysPassed > 7) return 'expired';
    
    return 'active';
  },

  // 收集市场数据
  collect() {
    const ticker = this.getTicker();
    const klines15m = this.getKlines('15m', 6);
    const dailyData = this.getKlines('1d', 14);
    
    // 计算最新EMA7
    let ema7 = 67485; // 默认值
    if (dailyData && dailyData.length >= 7) {
      const closes = dailyData.map(k => k.close);
      const multiplier = 2 / (7 + 1);
      ema7 = closes[0];
      for (let i = 1; i < closes.length; i++) {
        ema7 = (closes[i] - ema7) * multiplier + ema7;
      }
    }
    
    return {
      currentPrice: ticker?.last || 0,
      ema7: ema7,
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
    const { currentPrice, ema7, klines15m } = data;
    
    // 价格突破EMA7
    if (currentPrice >= ema7) {
      // 检查是否有放量
      const lastKline = klines15m[klines15m.length - 1] || {};
      const avgVolume = klines15m.reduce((sum, k) => sum + (k.volume || 0), 0) / klines15m.length;
      const hasVolume = (lastKline.volume || 0) > avgVolume * 1.5;
      
      return {
        triggered: true,
        significance: `价格突破EMA7($${Math.round(ema7)})阻力。${hasVolume ? '伴随放量，突破有效。' : '突破未放量，需观察持续性。'}这是pending做空建议的入场信号确认位置。若出现阻力确认（收阴、卖压），可入场做空。`
      };
    }
    
    return { triggered: false };
  },

  // 触发后的动作
  async action(data, result) {
    // 发送到七月执行即时分析
    await this.sendToAgent('july', {
      alertName: ALERT_NAME,
      alertType: 'resistance_breakthrough_ema7',
      triggerTime: new Date().toISOString(),
      ema7: data.ema7,
      currentPrice: data.currentPrice,
      ...data,
      message: result.significance
    });
  },

  // 获取API数据的方法（由警报器引擎注入）
  getTicker: null,
  getKlines: null,
  sendToAgent: null
};