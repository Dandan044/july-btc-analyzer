/**
 * 支撑跌破延迟警报 - $66,000（20分钟延迟确认）
 * 监控 BTC 价格跌破 $66,000，持续20分钟后触发即时分析
 * 来源：用户手动设定
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-03-31';
const TARGET_PRICE = 66000;
const DELAY_MS = 20 * 60 * 1000; // 20分钟延迟
const CHECK_INTERVAL = 3 * 60 * 1000; // 3分钟检查

module.exports = {
  name: '支撑跌破警报-66000-延迟20分钟',
  interval: CHECK_INTERVAL,
  
  // 内部状态
  breachTime: null, // 记录跌破时间
  triggered: false, // 是否已触发
  
  async check() {
    if (this.triggered) {
      return false; // 已触发，不再重复
    }
    
    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;
      console.log(`[警报检查] 当前价格: ${currentPrice}, 目标: ${TARGET_PRICE}`);
      
      if (currentPrice <= TARGET_PRICE) {
        // 价格跌破目标
        if (!this.breachTime) {
          // 首次跌破，记录时间
          this.breachTime = Date.now();
          console.log(`[警报状态] 首次跌破 $${TARGET_PRICE}，记录时间，等待20分钟确认`);
          return false; // 不立即触发，等待延迟
        } else {
          // 已跌破，检查是否满足延迟时间
          const elapsed = Date.now() - this.breachTime;
          if (elapsed >= DELAY_MS) {
            console.log(`[警报状态] 已跌破 ${elapsed / 60000} 分钟，满足20分钟延迟，触发警报`);
            return true;
          } else {
            console.log(`[警报状态] 已跌破 ${Math.floor(elapsed / 60000)} 分钟，等待剩余 ${Math.ceil((DELAY_MS - elapsed) / 60000)} 分钟`);
            return false;
          }
        }
      } else {
        // 价格回升，清除跌破记录（可选：保留或清除）
        if (this.breachTime) {
          console.log(`[警报状态] 价格回升至 $${currentPrice} > $${TARGET_PRICE}，清除跌破记录`);
          this.breachTime = null; // 重置，等待下次跌破
        }
        return false;
      }
    } catch (error) {
      console.error('[警报检查错误]', error.message);
      throw error;
    }
  },
  
  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '15m', 8);
      const fgi = await api.getFearGreedIndex(7);
      
      return {
        alertTime: new Date().toISOString(),
        breachTime: new Date(this.breachTime).toISOString(),
        delayMinutes: DELAY_MS / 60000,
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
        alertType: '支撑跌破-延迟确认',
        significance: `价格跌破$${TARGET_PRICE}后持续20分钟，确认有效跌破。这是$67,000-$65,000中间支撑，跌破后下一支撑为$65,000止损位。建议减仓观望或等待$65,000测试。`
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },
  
  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-support-66000-delayed-${Date.now()}`;
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
    console.log(`[警报详情] 跌破时间: ${data.breachTime}, 触发时间: ${data.alertTime}`);
    
    this.triggered = true; // 标记已触发
  },
  
  lifetime() {
    // 价格已跌破目标超过5%则失效
    const ticker = api.getTicker?.('BTC');
    if (ticker && ticker.price < TARGET_PRICE * 0.95) {
      return 'expired';
    }
    
    // 价格回升超过目标10%则休眠（警报失去意义）
    if (ticker && ticker.price > TARGET_PRICE * 1.10) {
      return 'dormant';
    }
    
    // 14天后自动过期
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 14 ? 'active' : 'expired';
  }
};