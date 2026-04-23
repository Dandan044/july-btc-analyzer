/**
 * 整数关口阻力突破警报 - $79,000
 * 触发条件：BTC 价格突破 $79,000 并延续（延迟确认20分钟）
 * 触发后：执行即时分析，评估是否开启B浪延长（目标 $80,000-$83,437）
 * 
 * 依据：04-22 23:10即时分析报告判断"$79,000 是整数关口，当前回调后的关键阻力"。
 *       报告指出"若有效突破日线50%，震荡上行至 $80,000-$83,000，概率30%"。
 *       当前价格 $78,951，已突破日线50% $78,963，若回踩后继续上行，
 *       $79,000 是下一个关键阻力（整数关口）。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-22';
const TARGET_PRICE = 79000;
const DELAY_MS = 20 * 60 * 1000; // 突破后等待20分钟确认
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '整数关口阻力突破警报-79000',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  // 延迟触发状态管理
  breakthroughTime: null,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker('BTC');
      const currentPrice = ticker.price;

      if (currentPrice >= TARGET_PRICE) {
        if (!this.breakthroughTime) {
          this.breakthroughTime = Date.now();
        }
        
        const elapsedMs = Date.now() - this.breakthroughTime;
        const elapsedMins = Math.floor(elapsedMs / 60000);
        const targetMins = DELAY_MS / 60000;
        const triggered = elapsedMins >= targetMins;
        
        console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 突破已持续: ${elapsedMins}分钟 | 等待确认: ${targetMins}分钟 | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: ${triggered} | [来源] 04-22 23:10即时分析: "$79,000是整数关口阻力，突破后目标$80,000-$83,437"`);
        
        if (triggered) {
          return true;
        }
      } else {
        if (this.breakthroughTime) {
          console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 状态: 突破失效 | 价格回落: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: false | [来源] 04-22 23:10即时分析: "$79,000是整数关口阻力"`);
          this.breakthroughTime = null;
        } else {
          console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: false | [来源] 04-22 23:10即时分析: "$79,000是整数关口阻力，突破后目标$80,000-$83,437"`);
        }
      }
      
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('BTC');
      const klines1h = await api.getKlines('BTC', '1h', 8);
      const klines4h = await api.getKlines('BTC', '4h', 4);
      
      // 计算1H成交量
      const avg1hVolume = klines1h.slice(0, 4).reduce((sum, k) => sum + k.volume, 0) / 4;
      const latest1hVolume = klines1h[0]?.volume || 0;
      
      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        volume24h: ticker.volume24h,
        triggerPrice: TARGET_PRICE,
        breakthroughTime: this.breakthroughTime ? new Date(this.breakthroughTime).toISOString() : null,
        delayMinutes: DELAY_MS / 60000,
        latest1hVolume: latest1hVolume,
        avg1hVolume: avg1hVolume,
        volumeRatio: (latest1hVolume / avg1hVolume).toFixed(2),
        klines1h: klines1h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        klines4h: klines4h.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '上方价格警报',
        significance: `价格突破 $${TARGET_PRICE}（整数关口，关键阻力）。突破后下一目标 $80,000-$83,437（日线61.8%）。需确认：1H成交量是否放量（>${(avg1hVolume/1e6).toFixed(1)}M均值），若放量阳线突破 → B浪延长信号；若缩量或长上影 → 可能见顶。若突破 $79,000，可考虑做多，止损 $78,500（-0.6%），止盈 $80,000（+1.3%）。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-79000-${Date.now()}`;
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
    this.breakthroughTime = null;
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
