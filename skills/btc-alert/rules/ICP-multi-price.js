/**
 * ICP 延迟确认多价位监控警报 - v2
 * 更新: TP1已触发(50%仓位平仓), TP2调整为$3.35, SL调整为$2.699
 *
 * 来源: active/alt-ICP-20260507-0704/reports/alt-report-ICP-2026-05-07-0751.md
 * 报告观点: 突破$3.2后回踩确认，剩余仓位持有。TP2=$3.35(全部), SL=$2.699
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'ICP';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const COIN = 'ICP';
const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000;

// ============================================================
// 多价位配置（5个价位 + 确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 3.35, type: 'resistance', label: 'TP2/日线0%Fib前',
    action: '第二止盈(全部)，评估是否重新入场', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },
  
  // 下方价位
  { price: 2.86, type: 'support', label: '日线38.2%Fib/结构支撑',
    action: '趋势弱化信号，评估减仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 2.699, type: 'support', label: '止损位',
    action: '全平止损，趋势反转确认', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },
    
  { price: 2.50, type: 'support', label: 'EMA密集区/最后防线',
    action: '结构完全破坏，禁止做多', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 }
];

const STABILITY = {
  maxRetracePercent: 0.15,
  resetOnCrossback: true
};

module.exports = {
  name: 'ICP-多价位延迟确认-v2',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getOKXKlines(COIN, '1m', 3);
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
            const retraced = (level.type === 'resistance' && latestPrice < level.price) ||
                            (level.type === 'support' && latestPrice > level.price);
            if (retraced) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null;
                allLogs.push(`${level.label}: 假突破回穿${retrace.toFixed(2)}%，重置`);
              }
            }
          }
          continue;
        }

        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT触发`);
          continue;
        }

        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及，${level.confirmMs/60000}min确认中...`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
        }
        this.breakoutExtremes[key] = level.type === 'resistance'
          ? Math.max(this.breakoutExtremes[key], latestPrice)
          : Math.min(this.breakoutExtremes[key], latestPrice);

        const elapsed = now - state.firstTouch;
        if (elapsed >= level.confirmMs) {
          if (!state.confirmed) {
            state.confirmed = true;
            confirmedLevels.push(level);
            allLogs.push(`${level.label}: 确认完成(${Math.floor(elapsed/60000)}min)`);
          }
        } else {
          allLogs.push(`${level.label}: ${Math.floor(elapsed/60000)}/${Math.floor(level.confirmMs/60000)}min`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍ICP检查] [API] OKX获取ICP 3根1m K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(3)}-$${periodHigh.toFixed(3)} | 当前: $${latestPrice.toFixed(3)} | ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-07 ICP即时分析: "突破$3.2后回踩确认，TP2=$3.35/SL=$2.699"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }
      return false;
    } catch (error) {
      console.error('[❌ICP检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      
      const ticker = await api.getOKXTicker(COIN);
      const klines15m = await api.getOKXKlines(COIN, '15m', 8);

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        triggeredLevels: triggeredLevels.map(l => {
          const key = String(l.price);
          const state = this.levelStates[key] || {};
          return {
            price: l.price, type: l.type, label: l.label,
            action: l.action, priority: l.priority,
            confirmPolicy: l.confirmPolicy, confirmMs: l.confirmMs,
            firstTouchTime: state.firstTouch ? new Date(state.firstTouch).toISOString() : null,
            confirmedAt: new Date(now).toISOString(),
            elapsedMs: state.firstTouch ? now - state.firstTouch : 0,
            stability: {
              touches: state.touches || 0,
              crossbacks: state.crossbacks || 0,
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price,
              maxRetracePct: l.confirmPolicy === 'instant' ? null :
                Math.abs((ticker.price - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        alertType: 'ICP多价位触发(延迟确认)',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌ICP数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    const labels = levels.map(l => `${l.label}($${l.price}, ${l.confirmPolicy})`);
    const actions = levels.filter(l => l.action).map(l => l.action);
    return `ICP多价位触发: ${labels.join('、')}${actions.length > 0 ? ' | 动作: ' + actions.join(' / ') : ''}`;
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-icp-${Date.now()}`;
    const json = JSON.stringify(data);
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [