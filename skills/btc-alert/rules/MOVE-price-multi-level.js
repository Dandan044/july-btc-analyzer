/**
 * MOVE 延迟确认多价位监控警报
 * 监控多个关键价位，使用K线区间数据捕捉瞬时突破
 * 每个价位有独立的确认策略，避免假突破误触发
 *
 * 来源：alt-report-MOVE-2026-05-13-0006.md
 * 报告观点：61.8%斐波那契支撑$0.01963已失守，偏空但盈亏比不足，等待$0.0205-$0.0210反弹做空
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'MOVE';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ============================================================
// ⭐ 多价位配置（每个价位带确认策略）
// ============================================================
const PRICE_LEVELS = [
  // 上方价位（阻力/做空入场区）
  { price: 0.02083, type: 'resistance', label: '4H破位点→阻力回测',
    action: '反弹至理想做空区间，评估入场', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.02142, type: 'resistance', label: '24H高点',
    action: '突破则空头结构被质疑', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.02287, type: 'resistance', label: '5月11日高点/反弹终点',
    action: '突破则反弹结构恢复，空头判断需修正', priority: 'high',
    confirmPolicy: 'deep_hold', confirmMs: 25 * 60 * 1000 },

  // 下方价位（支撑/做空目标区）
  { price: 0.01903, type: 'support', label: '4H 78.6%斐波那契',
    action: '跌破则加速下行至前低', priority: 'medium',
    confirmPolicy: 'hold', confirmMs: 10 * 60 * 1000 },

  { price: 0.01848, type: 'support', label: '5月9日低点/关键防线',
    action: '跌破确认趋势反转，做空加仓信号', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.01700, type: 'support', label: '日线支撑区',
    action: '深度下行目标', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 25 * 60 * 1000 }
];

// ============================================================
// ⭐ 稳定性检查参数
// ============================================================
const STABILITY = {
  maxRetracePercent: 0.1,     // 最大回穿幅度 %
  resetOnCrossback: true      // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: 'MOVE-延迟确认多价位监控',
  interval: 5 * 60 * 1000, // 5分钟检查（山寨币波动大，需要覆盖）
  lastTriggered: 0,

  // ⭐ 每个价位的独立确认状态
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 获取5根1分钟K线覆盖5分钟检查间隔
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
            const isCrossedBack = (level.type === 'resistance' && latestPrice < level.price) ||
                                  (level.type === 'support' && latestPrice > level.price);
            if (isCrossedBack) {
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
      console.log(`[🔍警报检查] [API] OKX获取${COIN} 5根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(5)}-$${periodHigh.toFixed(5)} | 当前: $${latestPrice.toFixed(5)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-13 00:06 MOVE即时分析: "61.8%斐波那契支撑失守，偏空但盈亏比不足1.2，等待$0.0205-$0.0210反弹做空"`);

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
      const klines4h = await api.getOKXKlines(COIN, '4h', 3, 'SWAP');

      let oiData = null, frData = null, lsData = null, takerData = null;
      try { oiData = await api.getOKXOpenInterest(COIN); } catch (e) { /* */ }
      try { frData = await api.getOKXFundingRate(COIN); } catch (e) { /* */ }
      try { lsData = await api.getOKXLongShortRatio(COIN); } catch (e) { /* */ }
      try { takerData = await api.getOKXTakerRatio(COIN); } catch (e) { /* */ }

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: 'price-multi-level',
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
          high: Math.max(...klines4h.slice(-2).map(k => k.high)),
          low: Math.min(...klines4h.slice(-2).map(k => k.low))
        },

        openInterest: oiData?.currentOI,
        fundingRate: frData?.fundingRate,
        longShortRatio: lsData?.currentRatio,
        takerBuyRatio: takerData?.currentRatio,
        klines4h: klines4h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),

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
    const jobName = `alert-MOVE-price-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}
以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[🔔警报触发] ${this.name} | 确认触发价位: ${data.triggeredLevels.length}个 | 当前价: $${data.currentPrice} | 策略: ${data.triggeredLevels.map(l=>l.confirmPolicy).join(',')}`);

    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};