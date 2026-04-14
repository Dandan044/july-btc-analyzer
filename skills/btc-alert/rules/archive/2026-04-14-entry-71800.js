/**
 * 持仓监控警报 - 多仓持仓中
 * 
 * ========== 持仓状态 ==========
 * 入场: $72,000 | 1x 全仓多仓
 * 当前: $74,420 (+3.4%)
 * 止盈: $73,500 (已突破) / $75,000
 * 止损: $70,500
 * 
 * ========== 更新记录 ==========
 * 2026-04-14 00:57 - 原计划等$71,800回踩加仓
 * 2026-04-14 07:59 - 用户同步：$72,000自行入场，1x全仓
 *                    价格已涨至$74,420，第一止盈位$73,500已突破
 * ==============================
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-14';
const ENTRY_PRICE = 72000;
const TP1 = 73500;
const TP2 = 75000;
const SL = 70500;
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '持仓监控-多仓',
  interval: 5 * 60 * 1000, // 5分钟检查一次
  lastTriggered: 0,
  lastPrice: 0,

  async check() {
    // 冷却检查
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const ticker = await api.getTicker('BTC');
      this.lastPrice = ticker.price;
      console.log(`[持仓监控] 当前价格: $${ticker.price}, 入场: $${ENTRY_PRICE}, TP1: $${TP1}(已突破), TP2: $${TP2}, SL: $${SL}`);
      
      // 触发条件：
      // 1. 回踩到 $71,800 以下（可能加仓机会）
      // 2. 触及第二止盈位 $75,000
      // 3. 触及止损位 $70,500
      
      const hitCallback = ticker.price <= 71800;
      const hitTP2 = ticker.price >= TP2;
      const hitSL = ticker.price <= SL;
      
      if (hitCallback) {
        return { type: 'callback', price: ticker.price };
      } else if (hitTP2) {
        return { type: 'take_profit_2', price: ticker.price };
      } else if (hitSL) {
        return { type: 'stop_loss', price: ticker.price };
      }
      
      return false;
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
        currentPrice: ticker.price,
        entryPrice: ENTRY_PRICE,
        pnl: ((ticker.price - ENTRY_PRICE) / ENTRY_PRICE * 100).toFixed(2) + '%',
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        fearGreedIndex: fgi.current,
        klines15m: klines.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '持仓监控',
        significance: '关键价位触发，需要决策'
      };
    } catch (error) {
      console.error('[数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-position-${Date.now()}`;
    
    const messageData = {
      ...data,
      triggerType: data.type
    };
    
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(messageData)}`;

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
    // 有效期7天（持仓周期）
    const today = new Date().toISOString().split('T')[0];
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};