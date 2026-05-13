/**
 * ENS 多价位监控警报（延迟确认）
 * 监控反弹做空入场位、关键支撑/阻力位
 *
 * 来源: alt-report-ENS-2026-05-13-2123.md
 * 报告观点: "条件性开仓做空，入场条件为价格反弹至$7.00-$7.10区间且4H Taker买卖比<1.0。
 *           $6.98跌破确认空头加速，4H Taker买卖比0.956，散户多空比1.21。
 *           OI持续减少(-27.7%)，下跌由多头溃败+团队抛压驱动，非新空头主动进攻。"
 * 更新: 入场区间调整为$7.00-$7.10，移除$7.59(太远)，新增$7.25(4H 38.2%fib/前阻力)
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'ENS';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// ⭐ 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位
  { price: 7.05, type: 'resistance', label: '$6.98支撑转阻力/反弹做空入场区间中点',
    action: '反弹做空入场评估', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },  // 入场触发，防假突破

  { price: 7.25, type: 'resistance', label: '4H斐波那契38.2%回撤位/前阻力',
    action: '强阻力反弹做空评估', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },  // 结构位需确认

  { price: 7.40, type: 'resistance', label: '止损位/前支撑转强阻力/空头格局失效线',
    action: '空头格局失效评估', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },  // 结构位需确认

  // 下方价位
  { price: 6.71, type: 'support', label: '4H斐波那契61.8%回撤位/TP1',
    action: '止盈1评估', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 },  // 止盈位快确认

  { price: 6.47, type: 'support', label: '日线61.8%回撤位/TP2',
    action: '止盈2评估', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000 }   // 止盈位快确认
];

// ============================================================
// ⭐ 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.15,    // 最大回穿幅度 %（ENS ATR 2.73%，0.1%太紧）
  resetOnCrossback: true      // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: 'ENS-多价位监控',
  interval: 3 * 60 * 1000,
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
      // 使用SWAP合约K线数据
      const klines = await api.getOKXKlines(COIN, '1m', 3, 'SWAP');
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
                state.firstTouch = null;
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
      console.log(`[🔍警报检查] [API] OKX获取${COIN} ${klines.length}根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(3)}-$${periodHigh.toFixed(3)} | 当前: $${latestPrice.toFixed(3)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

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

      const ticker = await api.getOKXTicker(COIN, 'SWAP');

      let oiData = null, lsData = null, takerData = null;
      try { oiData = await api.getOKXOpenInterest(COIN); } catch (e) { /* 静默 */ }
      try { lsData = await api.getOKXLongShortRatio(COIN); } catch (e) { /* 静默 */ }
      try { takerData = await api.getOKXTakerRatio(COIN); } catch (e) { /* 静默 */ }

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
          high: parseFloat(ticker.high24h || ticker.price),
          low: parseFloat(ticker.low24h || ticker.price)
        },

        openInterest: oiData?.currentOI,
        longShortRatio: lsData?.currentRatio,
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

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-price-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[${COIN}警报触发] 已派发即时分析任务: ${jobName} | 确认触发价位: ${data.triggeredLevels?.length || 0}个`);

    // ⭐ 重置所有价位状态
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    if (this.lastTriggered > 0 && Date.now() - this.lastTriggered < COOLDOWN_MS) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
