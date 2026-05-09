/**
 * AZTEC 多价位监控警报（即时分析 2026-05-09 07:24 更新）
 * 
 * 更新: 2026-05-09 07:24
 * 来源: active/alt-AZTEC-20260508-2104/reports/alt-report-AZTEC-2026-05-09-0724.md
 * 
 * 报告摘要: 已完成做多开仓，16张 @ $0.02566 long，10x
 *   TP1: $0.0275 (8张, OCO), TP2: $0.02999 (8张, offset, OCO)
 *   SL: $0.0223 (全仓, OCO)
 *   当前: $0.02562
 *   操作: 持有，等待TP/SL触发
 *   重点监控: 价格是否向TP或SL移动
 * 
 * 更新说明(2026-05-09 07:24):
 *   🆕 上下文: 已开仓做多，更新监控价位
 *   - 移除 $0.0255（已触发并执行入场）
 *   - 新增 $0.0240 (SL中途预警), $0.0223 (SL触发范围)
 *   - 新增 $0.0275 (TP1逼近), $0.0300 (TP2逼近)
 *   - 保留 $0.0280, $0.0320 作为远处阻力观测
 */

const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');
const api = require('../../btc-market-lite/scripts/api');

const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;
const COIN = 'AZTEC';

// ⭐ 多价位配置（每个价位带确认策略）
const PRICE_LEVELS = [
  // 下方价位 - SL预警区
  { price: 0.0240, type: 'support', label: '向SL回调预警',
    action: '价格从$0.0256回落至$0.0240，距离SL(0.0223)已不足8%。需评估回调性质：健康回踩还是趋势反转', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },

  { price: 0.0223, type: 'support', label: 'SL触发范围',
    action: '价格接近SL($0.0223)，OCO止损订单即将触发。分析平仓后的下一步操作', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 10 * 60 * 1000 },

  // 上方价位 - TP预警区
  { price: 0.0275, type: 'resistance', label: 'TP1逼近',
    action: '价格接近TP1($0.0275)，OCO止盈1即将触发50%仓位。评估是否需要调整止盈策略', priority: 'high',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.0280, type: 'resistance', label: 'TP1上方/阻力区',
    action: '$0.0280阻力区。TP1触发后若继续上行，评估是否仍有上行空间', priority: 'medium',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.0300, type: 'resistance', label: 'TP2逼近',
    action: '价格接近TP2($0.0300, 偏移后实际0.02999)，余下50%仓位即将触发止盈。评估是否全部平仓或追踪', priority: 'high',
    confirmPolicy: 'deep_hold', confirmMs: 20 * 60 * 1000 },

  { price: 0.0320, type: 'resistance', label: '远处阻力目标',
    action: '$0.0320远处阻力区。仅作为观测位，TP2触发完毕后可考虑反向操作', priority: 'low',
    confirmPolicy: 'deep_hold', confirmMs: 30 * 60 * 1000 },
];

const STABILITY = {
  maxRetracePercent: 0.2,
  resetOnCrossback: true
};

module.exports = {
  name: 'AZTEC 多价位监控（即时分析20260509-0724持仓更新版）',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,
  levelStates: {},
  currentTriggeredLevels: [],

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const raw = await api.fetch('https://www.okx.com/api/v5/market/candles?instId=AZTEC-USDT-SWAP&bar=1m&limit=5');
      if (!raw || !raw.data || raw.data.length === 0) {
        console.log('[AZTEC 多价位] OKX K线数据为空');
        return false;
      }

      const klines = raw.data.slice(-3).map(c => ({
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4])
      }));

      const periodHigh = Math.max(...klines.map(k => k.high));
      const periodLow = Math.min(...klines.map(k => k.low));
      const latestPrice = klines[klines.length - 1].close;
      const now = Date.now();
      const confirmedLevels = [];

      for (const level of PRICE_LEVELS) {
        const key = String(level.price);
        if (!this.levelStates[key]) {
          this.levelStates[key] = { firstTouch: null, touches: 0, crossbacks: 0, confirmed: false };
        }
        const state = this.levelStates[key];
        if (state.confirmed) continue;

        const wasTouched = (level.type === 'resistance' && periodHigh >= level.price) ||
                           (level.type === 'support' && periodLow <= level.price);

        if (wasTouched) {
          if (!state.firstTouch) {
            state.firstTouch = now;
          }
          state.touches++;
          const elapsed = now - state.firstTouch;

          if (level.confirmPolicy === 'instant') {
            state.confirmed = true;
            confirmedLevels.push(level);
          } else if (elapsed >= level.confirmMs) {
            state.confirmed = true;
            confirmedLevels.push(level);
          } else {
            const remaining = Math.round((level.confirmMs - elapsed) / 1000);
            console.log(`[AZTEC 多价位] 确认中: $${level.price}(${level.label}) 还要 ${remaining}s`);
          }
        } else {
          if (state.firstTouch && !state.confirmed) {
            const retrace = Math.abs((latestPrice - level.price) / level.price * 100);
            if (retrace > STABILITY.maxRetracePercent) {
              state.crossbacks++;
              state.firstTouch = null;
              console.log(`[AZTEC 多价位] 重置: $${level.price}(${level.label}) 回穿 ${retrace.toFixed(2)}%`);
            }
          }
        }
      }

      if (confirmedLevels.length > 0) {
        this.currentTriggeredLevels = confirmedLevels;
        const levelStr = confirmedLevels.map(l => `$${l.price}(${l.label})`).join(', ');
        console.log(`[AZTEC 多价位] 触发价位: ${levelStr}`);
        return true;
      }

      return false;
    } catch (error) {
      console.error('[AZTEC 多价位 ERROR]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const triggeredLevels = this.currentTriggeredLevels || [];

      const tickRaw = await api.fetch('https://www.okx.com/api/v5/market/ticker?instId=AZTEC-USDT-SWAP');
      const ticker = tickRaw?.data?.[0] || {};
      const currentPrice = parseFloat(ticker.last) || 0;

      let oiData = null;
      try {
        const oiRaw = await api.fetch('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=AZTEC&period=1D');
        oiData = oiRaw?.data?.[0];
      } catch (e) { /* ignore */ }

      return {
        coin: 'AZTEC',
        alertTime: new Date().toISOString(),
        currentPrice: currentPrice,
        priceChange24h: ticker.change24h || 0,

        triggeredLevels: triggeredLevels.map(l => ({
          price: l.price,
          type: l.type,
          label: l.label,
          action: l.action,
          priority: l.priority
        })),

        oiCurrent: oiData ? parseFloat(oiData[1]) : null,
        alertType: '多价位触发',
        hasPosition: true,
        positionDesc: '16张long @ $0.02566, TP1=$0.0275, TP2=$0.02999, SL=$0.0223'
      };
    } catch (error) {
      console.error('[AZTEC 多价位 collect ERROR]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-AZTEC-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.altcoin.model;
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

    console.log(`[AZTEC警报触发] 已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
  },

  lifetime() {
    const ageHours = (Date.now() - new Date(CREATED_DATE).getTime()) / (1000 * 60 * 60);
    return ageHours < 48 ? 'active' : 'expired';
  }
};
