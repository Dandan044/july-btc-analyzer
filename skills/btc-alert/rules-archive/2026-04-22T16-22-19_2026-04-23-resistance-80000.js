/**
 * 整数关口突破警报 - $80,000
 * 触发条件：BTC 价格突破 $80,000 并延续（延迟确认20分钟）
 * 触发后：执行即时分析，评估B浪第三阶段是否启动
 * 
 * 依据：04-23 00:15即时分析报告判断"情景B（有效突破 $79,500，震荡上行至 $80,000-$83,437，
 *       概率35%）：B浪第三阶段。触发条件：价格放量突破 $79,500（1H成交量高于 $500M）"。
 *       旗形向上目标 $80,000+，是整数大关。
 *       $79,443.4是即时高点（瞬间刺穿），$80,000是真正的整数大关。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-23';
const TARGET_PRICE = 80000;
const DELAY_MS = 20 * 60 * 1000; // 突破后等待20分钟确认
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '整数关口突破警报-80000',
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
        
        console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 突破已持续: ${elapsedMins}分钟 | 等待确认: ${targetMins}分钟 | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: ${triggered} | [来源] 04-23 00:15即时分析: "旗形向上目标$80,000+，有效突破确认后B浪第三阶段启动"`);
        
        if (triggered) {
          return true;
        }
      } else {
        if (this.breakthroughTime) {
          console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 状态: 突破失效 | 价格回落: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: false | [来源] 04-23 00:15即时分析: "旗形向上目标$80,000+"`);
          this.breakthroughTime = null;
        } else {
          console.log(`[🔍警报检查] [API] CryptoCompare获取BTC实时价格 | [进度] ${this.name} | 当前价: $${currentPrice} | 目标: $${TARGET_PRICE} | 触发: false | [来源] 04-23 00:15即时分析: "旗形向上目标$80,000+，有效突破确认后B浪第三阶段启动"`);
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
        significance: `价格突破 $${TARGET_PRICE}（整数大关，B浪第三阶段启动）。突破后下一目标 $83,437（日线61.8%）。需确认：1H成交量是否放量（>${(avg1hVolume/1e6).toFixed(1)}M均值），若放量阳线突破 → 做多信号B；若缩量或长上影 → 可能见顶。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-resistance-80000-${Date.now()}`;
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
