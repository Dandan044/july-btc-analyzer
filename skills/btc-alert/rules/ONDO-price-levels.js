/**
 * ONDO 多价位监控警报（延迟确认）
 * 更新：$0.426已确认突破并触发即时分析，翻转变为支撑
 * 新增：$0.406 4H23.6%斐波那契支撑位（结构位）
 * 
 * 当前分析：alt-report-ONDO-2026-05-09-0103.md
 * 当前价格: $0.4478 | 持仓: 9长 @ $0.4018 | 浮盈+11.4%
 * 判断：4H突破确认，趋势发展中段，持有观望
 * 短期超买（100% range position），暂不加仓
 * 上方：TP1 $0.49 (4张) / TP2 $0.56 (5张)
 * 止损: $0.3049
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'ONDO';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// 多价位配置（6个价位，每个带确认策略）
// 当前价格: $0.4478
// ============================================================
const PRICE_LEVELS = [
  // 下方价位（支撑跌破监控）↓
  { price: 0.4260, type: 'support', label: '突破转支撑/4H高点',
    action: '$0.426已确认突破，现转为支撑。若重新跌破，突破失败信号', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 0.4060, type: 'support', label: '4H 23.6%斐波那契/结构位',
    action: '结构支撑位，跌破需部分减仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 0.3700, type: 'support', label: '整数支撑/深度回调区域',
    action: '回调加深，评估持仓安全', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 0.3150, type: 'support', label: '止损预警区',
    action: '接近止损位($0.3049)，紧急评估', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },
  
  // 上方价位（阻力突破监控）↑
  { price: 0.4900, type: 'resistance', label: 'TP1目标位',
    action: '接近第一止盈($0.4899)，评估是否调整', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 0.5600, type: 'resistance', label: 'TP2目标位',
    action: '接近第二止盈($0.5599)', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 }
];

// ============================================================
// 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.15,    // 最大回穿幅度%
  resetOnCrossback: true      // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: 'ONDO-多价位监控',
  interval: 3 * 60 * 1000,  // 3分钟检查一次
  lastTriggered: 0,
  
  // 每个价位的独立确认状态
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getKlines(COIN, '1m', 3);
      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;
      const now = Date.now();
      const confirmedLevels = [];
      const allLogs = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
        }
        const state = this.levelStates[key];

        const wasTouched = (level.type === 'resistance' && periodHigh >= level.price) ||
                          (level.type === 'support' && periodLow <= level.price);

        if (!wasTouched) {
          if (state.firstTouch && !state.confirmed) {
            const isAboveLevel = (level.type === 'resistance' && latestPrice < level.price) ||
                                 (level.type === 'support' && latestPrice > level.price);
            if (isAboveLevel) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 假突破(${retrace.toFixed(2)}%回穿)`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: 即时触发`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及，${level.confirmMs/60000}分钟确认`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = level.type === 'resistance' ? latestPrice : latestPrice;
        }
        if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], latestPrice);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], latestPrice);
        }

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs) {
          if (!state.confirmed) {
            state.confirmed = true;
            confirmedLevels.push(level);
            allLogs.push(`${level.label}: ✅确认(${Math.floor(elapsed/60000)}分钟)`);
          }
        } else {
          allLogs.push(`${level.label}: 确认中(${Math.floor(elapsed/60000)}/${level.confirmMs/60000}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN} 3根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(4)}-$${periodHigh.toFixed(4)} | 触发: ${confirmedLevels.length > 0} | 状态: ${statusStr} | [来源] 05-09 ONDO即时分析: "持有观望，$0.426支撑/回调可加仓"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }
      return false;
    } catch (error) {
      console.error('[❌ONDO价位检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      const ticker = await api.getTicker(COIN);
      const klines15m = await api.getKlines(COIN, '15m', 4);

      return {
        coin: 'ONDO',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        
        triggeredLevels: triggeredLevels.map(l => {
          const key = String(l.price);
          const state = this.levelStates[key] || {};
          return {
            price: l.price,
            type: l.type,
            label: l.label,
            action: l.action,
            priority: l.priority,
            confirmPolicy: l.confirmPolicy,
            confirmMs: l.confirmMs,
            firstTouchTime: state.firstTouch ? new Date(state.firstTouch).toISOString() : null,
            confirmedAt: new Date(now).toISOString(),
            elapsedMs: state.firstTouch ? now - state.firstTouch : 0,
            stability: {
              touches: state.touches || 0,
              crossbacks: state.crossbacks || 0,
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price
            }
          };
        }),
        
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        alertType: '多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌ONDO数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    if (levels.length === 1) {
      const l = levels[0];
      return l.action
        ? `${l.label}($${l.price}) 确认${l.confirmMs/60000}分钟后触发: ${l.action}`
        : `${l.label}($${l.price}) 已确认触发`;
    }
    return `多价位确认触发: ${levels.map(l => `${l.label}($${l.price})`).join('、')}`;
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-ONDO-levels-${Date.now()}`;
    const model = CONFIG.trigger.altcoin.model;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', model,
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[ONDO警报触发] 已派发即时分析: ${jobName} | 确认价位: ${data.triggeredLevels.length}个`);
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
