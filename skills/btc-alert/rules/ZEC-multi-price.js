/**
 * ZEC 多价位监控警报（延迟确认）v6
 * 监控 ZEC 6个关键价位，延迟确认防假突破
 *
 * v6更新: 基于 alt-report-ZEC-20260507-1025.md (即时分析—Taker买入比飙升警报触发)
 *         止损从$575收紧至$565(整数位+1tick偏移→565.01实盘执行)
 *         买盘持续偏强但价格下行→做空逻辑维持
 *         维持空单7张@$544.83, SL=$565, TP1=$535, TP2=$507
 * v5历史: 基于10:05分析，警报信号被市场吸收
 * v4历史: 基于09:46分析，开空后监控$550/$575/$535/$507/$492
 * v3历史: 基于01:36报告，观望阶段监控$606/$590/$585/$550/$535
 */

const api = require('../../btc-market-lite/scripts/api');
const { execSync } = require('child_process');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'ZEC';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const PROXY_URL = 'http://127.0.0.1:7890';

// ⭐ 多价位配置（含确认策略）v6 — 即时分析更新(SL收紧至565)
const PRICE_LEVELS = [
  // 上方价位（空头风险监控）
  {
    price: 560, type: 'resistance', label: '做空逻辑弱化位/早期预警',
    action: '价格回升至$560→短期做空逻辑弱化→评估是否需要提前平仓',
    priority: 'high', confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000
  },
  {
    price: 565, type: 'resistance', label: '止损位(Taker买入比飙升后收紧)',
    action: '触及止损位$565→空头逻辑失败→仓位已由OKX止损($565.01实盘)',
    priority: 'critical', confirmPolicy: 'instant', confirmMs: 0
  },
  {
    price: 568, type: 'resistance', label: '警报拒止位/Taker买盘被吸收点',
    action: '价格回升至$568→空头压制完全失效→做空逻辑需重新评估',
    priority: 'high', confirmPolicy: 'hold', confirmMs: 20 * 60 * 1000
  },

  // 下方价位（空头目标/支撑）
  {
    price: 535, type: 'support', label: 'TP1/4H Fib 23.6%/清算真空区',
    action: '第一止盈目标→评估是否调整TP2或全部平仓',
    priority: 'high', confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000
  },
  {
    price: 507, type: 'support', label: 'TP2/日线Fib 23.6%/远端支撑',
    action: '第二止盈目标→全部平仓',
    priority: 'high', confirmPolicy: 'touch', confirmMs: 5 * 60 * 1000
  },
  {
    price: 492, type: 'support', label: '4H Fib 38.2%/深度支撑',
    action: '深度回调评估→若跌至此位趋势可能加速下跌',
    priority: 'medium', confirmPolicy: 'deep_hold', confirmMs: 25 * 60 * 1000
  }
];

// ⭐ 稳定性检查参数
const STABILITY = {
  maxRetracePercent: 0.1,     // 最大回穿幅度 %
  resetOnCrossback: true      // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: 'ZEC多价位监控警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  // 每个价位的独立确认状态
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const klines = await api.getKlines('ZEC', '1m', 3);
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
      console.log(`[🔍警报检查] [API] CryptoCompare获取ZEC ${klines.length}根1分钟K线 | [进度] ${this.name} | 区间: $${periodLow.toFixed(0)}-$${periodHigh.toFixed(0)} | 当前: $${latestPrice.toFixed(2)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0} | [来源] 05-07 10:25即时分析: "Taker买入比飙升警报触发→分析结论维持做空→SL收紧至$565。$560突破需预警，$568突破则空头逻辑完全失效。TP1=$535 TP2=$507"`);

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

      const ticker = await api.getTicker('ZEC');
      const klines15m = await api.getKlines('ZEC', '15m', 8);

      let oiData = null;
      try {
        const result = execSync(
          `curl -s --max-time 15 --proxy "${PROXY_URL}" "https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1D"`,
          { encoding: 'utf8', timeout: 20000 }
        );
        const oiJson = JSON.parse(result);
        const oiArr = (oiJson.data || []).reverse();
        const currentOI = oiArr.length > 0 ? parseFloat(oiArr[0].oi) : null;
        const prevOI = oiArr.length > 1 ? parseFloat(oiArr[1].oi) : null;
        oiData = { currentOI, prevOI };
      } catch (e) { /* 静默 */ }

      return {
        coin: 'ZEC',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        alertName: this.name,

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

        openInterest: oiData,
        klines15m: klines15m.map(k => ({
          time: k.datetime,
          open: k.open,
          high: k.high,
          low: k.low,
          close: k.close,
          volume: k.volume
        })),
        alertType: '多价位触发'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${alertData.coin}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [