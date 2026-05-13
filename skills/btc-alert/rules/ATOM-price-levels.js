/**
 * ATOM 延迟确认多价位监控警报
 * 
 * 来源: alt-report-ATOM-2026-05-13-2149.md
 * 报告观点: "4H 38.2%回撤位$2.082确认跌破，回落加速期，加仓做空31张@$2.1127"
 * 当前仓位: 做空31张@$2.1127, TP1=$1.996, TP2=$1.957, SL=$2.239
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'ATOM';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// ⭐ 多价位配置（每个价位带确认策略）
const PRICE_LEVELS = [
  // 上方价位（做空持仓的威胁位）
  { price: 2.233, type: 'resistance', label: '4H波段高点/止损位',
    action: '空头失效，止损触发', priority: 'critical',
    confirmPolicy: 'instant', confirmMs: 0 },
    
  { price: 2.140, type: 'resistance', label: '4H 23.6%回撤位',
    action: '反弹信号，需评估是否减仓', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
  
  // 下方价位（做空持仓的利好位）
  { price: 2.036, type: 'support', label: '4H 50%回撤位',
    action: '回落加速确认，可考虑加仓做空', priority: 'high',
    confirmPolicy: 'hold', confirmMs: 15 * 60 * 1000 },
    
  { price: 1.990, type: 'support', label: '4H 61.8%回撤位/TP1附近',
    action: '深度回落，止盈区域', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 },
    
  { price: 1.949, type: 'support', label: '日线Bollinger中轨/TP2附近',
    action: '趋势性下跌确认', priority: 'medium',
    confirmPolicy: 'touch', confirmMs: 3 * 60 * 1000 }
];

// ⭐ 稳定性检查参数（山寨币波动率较高，回穿容忍度适当放大）
const STABILITY = {
  maxRetracePercent: 0.15,     // 最大回穿幅度 %（ATOM日波动~3-4%，0.15%合理）
  resetOnCrossback: true       // 价格回穿超过阈值时重置计时
};

module.exports = {
  name: 'ATOM-延迟确认多价位监控',
  interval: 5 * 60 * 1000,     // 5分钟检查（山寨币波动大，稍低频）
  lastTriggered: 0,
  
  // ⭐ 每个价位的独立确认状态
  levelStates: {},
  currentTriggeredLevels: [],
  breakoutExtremes: {},
  triggeredHistory: [],

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // ⭐ 使用SWAP合约数据
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
            const isOnOtherSide = (level.type === 'resistance' && latestPrice < level.price) ||
                                 (level.type === 'support' && latestPrice > level.price);
            if (isOnOtherSide) {
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
      console.log(`[🔍警报检查] [API] OKX获取${COIN} ${klines.length}根1分钟K线(SWAP) | [进度] ${this.name} | 区间: $${periodLow.toFixed(3)}-$${periodHigh.toFixed(3)} | 当前: $${latestPrice.toFixed(3)} | 状态: ${statusStr} | 触发: ${confirmedLevels.length > 0}`);

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
      const klines4h = await api.getOKXKlines(COIN, '4H', 3, 'SWAP');
      
      let takerBuyRatio = null;
      try {
        const takerResp = await api.fetch(
          `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=1D`
        );
        if (takerResp && takerResp.data && takerResp.data[0]) {
          const buyVol = parseFloat(takerResp.data[0][2]);
          const sellVol = parseFloat(takerResp.data[0][3]);
          if (buyVol + sellVol > 0) {
            takerBuyRatio = buyVol / (buyVol + sellVol);
          }
        }
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
        takerBuyRatio: takerBuyRatio,
        klines4h: klines4h.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
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

    console.log(`[${COIN}警报触发] 已派发即时分析任务: ${jobName} | 确认触发价位: ${data.triggeredLevels.length}个 | 确认策略: ${data.triggeredLevels.map(l=>l.confirmPolicy).join(',')}`);
    
    this.triggeredHistory.push({
      time: new Date().toISOString(),
      levels: data.triggeredLevels
    });
    
    // ⭐ 重置所有价位状态
    this.lastTriggered = Date.now();
    this.currentTriggeredLevels = [];
    this.levelStates = {};
    this.breakoutExtremes = {};
  },

  lifetime() {
    // ⭐ 触发后即归档
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};