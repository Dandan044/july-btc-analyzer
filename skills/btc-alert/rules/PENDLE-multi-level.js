/**
 * PENDLE 多价位监控警报（延迟确认）
 * 
 * 来源：alt-PENDLE-20260511-1706/reports/alt-report-PENDLE-2026-05-13-1819.md
 * 报告观点：$2.091确认跌破+4H RSI<50+4H MACD死叉+1H Taker偏空持续16小时+OI空头增仓。
 *          短期偏空信号全面占优。$2.15从支撑转为阻力。止损$1.960距当前5.8%。
 *          持仓维持，不追加不调止损。风险等级上调为高。
 *          观察：4H站回$2.091→偏空解除；价格触及$1.978→中期结构关键支撑。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'PENDLE';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// ⭐ 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（站回确认）
  { price: 2.091, type: 'resistance', label: '4H支撑底线站回确认',
    action: '站回→短期结构弱化解除，偏空信号消退', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 2.15, type: 'resistance', label: '1H支撑转阻力位',
    action: '站回→偏多信号回归，需重新确认', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 2.165, type: 'resistance', label: '今日高点/短期阻力',
    action: '突破→测试$2.208前高', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  
  // 下方价位
  { price: 1.978, type: 'support', label: '4H 23.6%斐波那契',
    action: '跌破→深度回调信号，中期偏多结构受损，需评估提前止损', priority: 'high',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },
    
  { price: 1.960, type: 'support', label: 'OCO止损位',
    action: 'OCO自动执行', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 }
];

// ============================================================
// ⭐ 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 1.5,     // 山寨币波动大，允许1.5%回穿
  resetOnCrossback: true      // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: 'PENDLE-多价位监控',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,
  
  // ⭐ 每个价位的独立确认状态
  levelStates: {},
  
  // 本次触发的价位列表（供 collect 使用）
  currentTriggeredLevels: [],
  
  // 突破深度追踪
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getOKXKlines(COIN, '1m', 5, 'SWAP');
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

        // ⭐ 检测是否触及
        const wasTouched = (level.type === 'resistance' && periodHigh >= level.price) ||
                          (level.type === 'support' && periodLow <= level.price);

        if (!wasTouched) {
          // 价格未触及 → 检查是否需要重置已开始的计时
          if (state.firstTouch && !state.confirmed) {
            const isAboveLevel = (level.type === 'resistance' && latestPrice < level.price) ||
                                 (level.type === 'support' && latestPrice > level.price);
            if (isAboveLevel) {
              const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
              if (retrace > STABILITY.maxRetracePercent) {
                state.crossbacks++;
                state.firstTouch = null; // 重置计时
                allLogs.push(`${level.label}: 假突破，回穿${retrace.toFixed(2)}%，重置`);
              }
            }
          }
          continue;
        }

        // ⭐ 触及了 → 按确认策略处理
        
        // Instant: 直接触发
        if (level.confirmPolicy === 'instant') {
          confirmedLevels.push(level);
          allLogs.push(`${level.label}: INSTANT触发`);
          continue;
        }

        // ⭐ 延迟确认：记录首次触及时间
        if (!state.firstTouch) {
          state.firstTouch = now;
          state.touches++;
          allLogs.push(`${level.label}: 首次触及，开始${level.confirmMs/60000}分钟确认...`);
          continue;
        }

        // 追踪突破深度
        if (!this.breakoutExtremes[key]) {
          this.breakoutExtremes[key] = latestPrice;
        }
        if (level.type === 'resistance') {
          this.breakoutExtremes[key] = Math.max(this.breakoutExtremes[key], latestPrice);
        } else {
          this.breakoutExtremes[key] = Math.min(this.breakoutExtremes[key], latestPrice);
        }

        // ⭐ 检查确认时间是否达到
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

      // ⭐ 日志输出
      const statusStr = allLogs.length > 0 ? allLogs.join(' | ') : '无触及';
      console.log(`[🔍警报检查] [API] OKX获取${COIN} 5根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(3)}-$${periodHigh.toFixed(3)} | 当前: $${latestPrice.toFixed(3)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-13 18:19即时分析: "$2.091确认跌破+4H RSI<50+4H MACD死叉，短期偏空全面占优"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌PENDLE多价位警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();
      
      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const klines4h = await api.getOKXKlines(COIN, '4H', 3, 'SWAP');
      
      let oiData = null, takerData = null;
      try {
        oiData = await api.getOKXOpenInterest(COIN);
        takerData = await api.getOKXTakerRatio(COIN);
      } catch (e) { /* 静默 */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        // ⭐ 确认增强字段
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
          high: Math.max(...klines4h.map(k => k.high)),
          low: Math.min(...klines4h.map(k => k.low))
        },
        
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        openInterest: oiData?.currentOI,
        takerBuyRatio: takerData?.currentRatio,
        klines4h: klines4h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        alertType: '持仓管理多价位触发（延迟确认）',
        significance: this.buildSignificance(triggeredLevels)
      };
    } catch (error) {
      console.error('[❌PENDLE数据收集错误]', error.message);
      throw error;
    }
  },

  buildSignificance(levels) {
    if (levels.length === 0) return '无触发';
    if (levels.length === 1) {
      const l = levels[0];
      const confirmDesc = l.confirmPolicy === 'instant' ? '立即触发' : `确认${l.confirmMs/60000}分钟后触发`;
      return l.action
        ? `${l.label}($${l.price}) ${confirmDesc}，${l.action}`
        : `${l.label}($${l.price}) ${confirmDesc}`;
    }
    const labels = levels.map(l => `${l.label}($${l.price}, ${l.confirmPolicy})`);
    return `多价位确认触发: ${labels.join('、')}`;
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
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
    ], { detached: true, stdio: 'ignore' });

    console.log(`[${COIN}警报触发] 已派发即时分析任务: ${jobName} | 确认触发价位: ${alertData.triggeredLevels.length}个`);
    
    // ⭐ 重置所有价位状态
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    // ⭐ 触发后保留（多价位需要持续监控）
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};