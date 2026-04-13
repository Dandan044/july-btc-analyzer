/**
 * 情绪极端警报
 * 监控恐惧贪婪指数达到极端值（<10 或 >80）
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-10';
const FGI_LOWER = 10;  // 极度恐惧阈值
const FGI_UPPER = 80;  // 极度贪婪阈值
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '情绪极端警报',
  interval: 30 * 60 * 1000, // 30分钟检查一次（情绪更新较慢）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const fgi = await api.getFearGreedIndex(7);
      const current = fgi.current;
      
      console.log(`[情绪警报检查] 当前FGI: ${current}, 极端恐惧阈值: ${FGI_LOWER}, 极度贪婪阈值: ${FGI_UPPER}`);
      
      // FGI < 10 或 > 80 都触发
      return current <= FGI_LOWER || current >= FGI_UPPER;
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const fgi = await api.getFearGreedIndex(30);
      const current = fgi.current;

      // 判断情绪方向
      const emotionType = current <= FGI_LOWER ? '极度恐惧' : '极度贪婪';
      
      // 计算情绪变化趋势
      const recent = fgi.history.slice(-7);
      const avgRecent = recent.reduce((a, b) => a + b.value, 0) / recent.length;
      const trend = current < avgRecent ? '下降' : '上升';

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        fearGreedIndex: current,
        emotionType: emotionType,
        emotionTrend: trend,
        avgRecent7d: Math.round(avgRecent),
        fgiHistory: fgi.history.slice(-14).map(h => ({
          date: h.timestamp.split('T')[0],
          value: h.value,
          classification: h.classification
        })),
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h,
          '7d': ticker.change7d
        },
        alertType: '情绪极端',
        significance: '市场情绪达到极端值，可能预示反转机会或加剧波动'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-emotion-${Date.now()}`;
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
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};