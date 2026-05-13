/**
 * PENGU 多价位延迟确认监控警报
 * 
 * 来源: alt-report-PENGU-2026-05-13-2020.md
 * 报告观点: "三维共振空头，出货+解锁+下跌趋势，5月17日703.92M代币解锁是确定性催化剂"
 * 持仓: 做空 PENGU 38张 @ 0.009266, TP1=0.008931, TP2=0.007867, SL=0.009951
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 整体冷却 1小时

// ============================================================
// ⭐ 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 下方价位（做空方向，价格下跌触发）
  { price: 0.008913, type: 'support', label: 'TP1止盈/4H Fib 100%',
    action: '第一止盈触发(50%)', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },
    
  { price: 0.007793, type: 'support', label: 'TP2止盈/日线Fib 61.8%',
    action: '第二止盈触发(剩余)', priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },
  
  // 上方价位（做空方向，价格反弹触发警报）
  { price: 0.009951, type: 'resistance', label: 'SL止损位',
    action: '止损触发，全平', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },
    
  { price: 0.010041, type: 'resistance', label: '4H Fib 50%/趋势反转信号',
    action: '反弹到此需重新审视空头逻辑', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 0.010345, type: 'resistance', label: '5月12日高点/空头失败确认',
    action: '空头逻辑彻底失效', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 }
];

// ============================================================
// ⭐ 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.3,     // PENGU波动率较高，回穿容忍度0.3%
  resetOnCrossback: true
};

module.exports = {
  name: 'PENGU多价位延迟确认监控',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines('PENGU', '1m', 3, 'SWAP');
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
                allLogs.push(`${level.label}: 假突破，回穿${retrace.toFixed(2)}%，重置`);
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
          allLogs.push(`${level.label}: 首次触及，开始${level.confirmMs/60000}分钟确认...`);
          continue;
        }

        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
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
            const elapsedMins = Math.floor(elapsed / 60000);
            allLogs.push(`${level.label}: 确认完成(${elapsedMins}分钟)`);
          }
        } else {
          const elapsedMins = Math.floor(elapsed / 60000);
          const targetMins = Math.floor(level.confirmMs / 60000);
          allLogs.push(`${level.label}: 确认中(${elapsedMins}/${targetMins}分钟)`);
        }
      }

      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取PENGU ${klines.length}根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(6)}-$${periodHigh.toFixed(6)} | 当前: $${latestPrice.toFixed(6)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-13 山寨报告: "三维共振空头，5月17日解锁是确定性催化剂"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      
      const ticker = await api.getTicker('PENGU', 'SWAP');
      const klines4h = await api.getKlines('PENGU', '4h', 5, 'SWAP');
      
      let oiData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest('PENGU');
        takerData = await api.getOKXTakerRatio('PENGU');
      } catch (e) { /* 静默 */ }

      return {
        coin: 'PENGU',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
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
              breakoutExtreme: this.breakoutExtremes[key] || ticker.price,
              maxRetracePct: l.confirmPolicy === 'instant' ? null : 
                Math.abs((ticker.price - l.price) / l.price * 100).toFixed(3)
            }
          };
        }),
        
        periodRange: {
          high: Math.max(...klines4h.slice(-3).map(k => k.high)),
          low: Math.min(...klines4h.slice(-3).map(k => k.low))
        },
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        
        alertType: '多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    const labels = levels.map(l => `${l.label}($${l.price}, ${l.confirmPolicy})`);
    return `PENGU ${levels.length}个价位确认触发: ${labels.join(', ')}`;
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-PENGU-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[PENGU警报触发] 已派发即时分析任务: ${jobName} | 确认触发价位: ${alertData.triggeredLevels?.length || 0}个`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    // 5月17日解锁后需要继续监控，设5天有效期
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};
