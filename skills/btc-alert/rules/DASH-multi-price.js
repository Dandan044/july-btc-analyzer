/**
 * DASH 延迟确认多价位监控警报 v10（做空持仓·SL收紧·激进止盈）
 * 监控 DASH-USDT-SWAP 的 6 个核心价位，做空持仓视角
 *
 * 来源: active/alt-DASH-20260506-2004/reports/alt-report-DASH-20260507-1027.md
 * 报告观点: "$51.20支撑已放量跌破(2.99x)，短期明确偏空。SL收紧至$52.51，
 *           新增$48.81止盈档。目标$47.01(日线0.5 Fib)"
 * 持仓: Short 37张@$54.41, TP1$48.81(18张), TP2$47.01(19张), SL$52.51(OCO)
 * 创建: 2026-05-07T10:31
 * v10变更: SL从$54.01收紧至$52.51, 移除$53.00/$54.01, 新增$50.00心理位/$45.86深度支撑,
 *          $48.74→$48.81(新TP1), $47.02→$47.01(TP2精确值)
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'DASH';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07T10:31';
const COOLDOWN_MS = 60 * 60 * 1000;

const PRICE_LEVELS = [
  // ⬆️ 上方价位（空头威胁——趋势反转/止损信号）
  { price: 52.51, type: 'resistance', label: 'SL止损位($52.51/OCO/37张)',
    action: '止损触发，空头逻辑被推翻。37张全部平仓。从当前价反弹+$1.60触发。',
    priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },

  { price: 51.20, type: 'resistance', label: '已破日线0.382支撑→阻力(v10)',
    action: '价格反弹收复$51.20+站稳15min，空头趋势弱化。Taker>1.0确认则考虑手动平仓',
    priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  // ⬇️ 下方价位（空头目标/确认）
  { price: 50.00, type: 'support', label: '心理整数关口/超卖反弹区(v10新增)',
    action: '触及$50.00整数关口，警惕超卖反弹。不操作但需关注',
    priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  { price: 48.81, type: 'support', label: 'TP1(OCO 18张)/4h Fib 38.2%(v10调整)',
    action: '第一止盈触发(50%仓位)，剩余19张继续看$47.01',
    priority: 'high',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },

  { price: 47.01, type: 'support', label: 'TP2(OCO 19张)/日线50% Fib',
    action: '第二止盈触发(全部平仓)，空头目标达成。准备归档周期',
    priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 30 * 60 * 1000 },

  { price: 45.86, type: 'support', label: '4h 0.5 Fib/深度回调区(v10新增)',
    action: '跌入深度回调区。若OCO触达此处说明TP2已被跳过或部分触发，评估下行空间',
    priority: 'low',
    confirmPolicy: 'deep_hold', confirmMs: 30 * 60 * 1000 }
];

const STABILITY = {
  maxRetracePercent: 0.1,
  resetOnCrossback: true
};

module.exports = {
  name: 'DASH-多价位监控(v10·SL$52.51·37张short·激进止盈)',
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
      const klines = await api.getKlines('DASH', '1m', 3);
      if (!klines || klines.length === 0) {
        console.log('[🔍DASH警报v10] [API] DASH K线为空，跳过');
        return false;
      }

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
            const isAbandoned = (level.type === 'resistance' && latestPrice < level.price) ||
                               (level.type === 'support' && latestPrice > level.price);
            if (isAbandoned) {
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
          allLogs.push(`${level.label}: 首次触及$${level.price}，开始${level.confirmMs / 60000}分钟确认...`);
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
      console.log(`[🔍DASH警报v10] [API] DASH ${klines.length}根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(2)}-$${periodHigh.toFixed(2)} | 当前: $${latestPrice.toFixed(2)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] DASH 10:27即时分析: "SL收紧$52.51·激进止盈"`);

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        return true;
      }

      return false;
    } catch (error) {
      console.error('[❌DASH警报v10错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];
      const now = Date.now();

      let tickerPrice = 0;
      try {
        const raw = await api.fetch('https://www.okx.com/api/v5/market/ticker?instId=DASH-USDT-SWAP');
        if (raw && raw.code === '0' && raw.data && raw.data[0]) {
          tickerPrice = parseFloat(raw.data[0].last);
        }
      } catch (e) { /* 静默 */ }

      return {
        coin: 'DASH',
        alertTime: new Date().toISOString(),
        currentPrice: tickerPrice,

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
              breakoutExtreme: this.breakoutExtremes[key] || tickerPrice
            }
          };
        }),

        alertType: '多价位触发（延迟确认）',
        significance: triggeredLevels.length === 1
          ? `${triggeredLevels[0].label}($${triggeredLevels[0].price}) ${triggeredLevels[0].confirmPolicy}确认触发`
          : `多价位确认触发: ${triggeredLevels.map(l => l.label).join('、')}`
      };
    } catch (error) {
      console.error('[❌DASH数据收集错误v10]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-DASH-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [