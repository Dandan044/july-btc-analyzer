/**
 * 警报规则：多空比回落跌破2.0
 * 来源：instant-report-2026-03-31-0931
 * 意义：当前多空比回升超过2.0（2.05），若回落跌破2.0说明信号再次反转
 */

const ALERT_NAME = 'ratio-fall-2';
const TARGET_RATIO = 2.0;
const DIRECTION = 'down'; // 向下跌破

module.exports = {
  name: ALERT_NAME,

  // 获取规则元数据
  meta() {
    return {
      name: ALERT_NAME,
      target: '多空比 < 2.0',
      direction: DIRECTION,
      description: `多空比回落跌破2.0，信号再次反转（从多头倾向转为空头倾向）`,
      createdAt: '2026-03-31T09:31:00+08:00',
      source: 'instant-report-2026-03-31-0931'
    };
  },

  // 判断规则是否存活
  lifetime() {
    // 7天后自动过期
    const createdAt = new Date('2026-03-31T09:31:00+08:00');
    const now = new Date();
    const daysPassed = (now - createdAt) / (1000 * 60 * 60 * 24);
    if (daysPassed > 7) return 'expired';
    
    return 'active';
  },

  // 收集市场数据
  collect() {
    const ticker = this.getTicker();
    const klines4h = this.getKlines('4h', 6);
    const dailyData = this.getKlines('1d', 14);
    
    // 获取最新多空比（从4h K线）
    let longShortRatio = 2.05; // 默认值（当前）
    if (klines4h && klines4h.length > 0) {
      const latest = klines4h[klines4h.length - 1];
      longShortRatio = latest.longShortRatio || 2.05;
    }
    
    // 计算30日多空比均值
    let avgRatio30d = 1.8;
    if (dailyData && dailyData.length >= 30) {
      const ratios = dailyData.slice(-30).map(k => k.longShortRatio || 1);
      avgRatio30d = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    }
    
    return {
      currentPrice: ticker?.last || 0,
      longShortRatio: longShortRatio,
      avgRatio30d: avgRatio30d,
      priceChange: {
        '1h': ticker?.priceChangePercent1h || '0',
        '24h': ticker?.priceChangePercent24h || '0'
      },
      klines4h: klines4h || []
    };
  },

  // 判断是否触发
  evaluate(data) {
    const { longShortRatio, avgRatio30d, currentPrice, klines4h } = data;
    
    // 多空比跌破2.0
    if (longShortRatio < TARGET_RATIO) {
      // 检查趋势：是否连续下降
      const recentRatios = klines4h.slice(-4).map(k => k.longShortRatio || 2);
      const isDeclining = recentRatios.every((r, i) => i === 0 || r <= recentRatios[i - 1]);
      
      return {
        triggered: true,
        significance: `多空比跌破2.0阈值（当前${longShortRatio.toFixed(2)}）。${isDeclining ? '连续下降趋势确认，' : ''}散户信心再次转弱，可能预示价格回调或下跌。当前价格$${Math.round(currentPrice)}。`
      };
    }
    
    return { triggered: false };
  },

  // 触发后的动作
  async action(data, result) {
    // 发送到七月执行即时分析
    await this.sendToAgent('july', {
      alertName: ALERT_NAME,
      alertType: 'ratio_fall_below_2',
      triggerTime: new Date().toISOString(),
      longShortRatio: data.longShortRatio,
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