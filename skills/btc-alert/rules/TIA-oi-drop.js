/**
 * TIA 持仓量(OI)下降警报 v2（修复版）
 * 监控 TIA OI 是否从近期峰值显著下降（>10%）
 *
 * v2 修复: 使用1h K线数据计算滚动峰值，不再依赖易重置的模块级变量
 *
 * 报告参考: 06:39 TIA即时分析 — OI见顶回落信号需关注
 * 当前OI状态: 峰值2.91M(05:00)→当前2.81M(-3.4%)，暂未达阈值
 * 若OI持续下降至<2.6M(↓10%)+价格回落至0.42以下=动能衰竭确认
 */
const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'TIA';
const CREATED_DATE = '2026-05-09';
const COOLDOWN_MS = 60 * 60 * 1000;

// 使用滚动窗口时长（小时）：计算过去N小时的峰值OI
const LOOKBACK_HOURS = 12;

// OI 下降阈值（峰值下跌百分比）
const OI_DROP_PERCENT = 10;

module.exports = {
  name: 'TIA持仓量下降警报v2',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 获取1h K线数据（含OI）来滚动计算峰值
      const klines = await api.getOKXKlines(COIN, '1h', LOOKBACK_HOURS, 'SWAP');

      // 从K线提取OI数据
      const oiValues = klines
        .filter(k => k.openInterest !== undefined && k.openInterest !== null && k.openInterest > 0)
        .map(k => k.openInterest);

      if (oiValues.length < 3) {
        console.log(`[🔍警报检查] [API] OKX获取TIA 1hK线 | [进度] ${this.name} | OI数据不足(${oiValues.length}个)，跳过检查`);
        return false;
      }

      // 计算滚动窗口内的峰值OI和当前OI（最后一根K线）
      const peakOI = Math.max(...oiValues);
      const currentOI = oiValues[oiValues.length - 1];

      const dropPct = ((peakOI - currentOI) / peakOI) * 100;
      const triggered = dropPct >= OI_DROP_PERCENT;

      console.log(`[🔍警报检查] [API] OKX获取TIA 1hK线(${LOOKBACK_HOURS}h) | [进度] ${this.name} | OI当前: ${currentOI.toFixed(0)} | 峰值: ${peakOI.toFixed(0)} | 下降: ${dropPct.toFixed(1)}% | 阈值: ${OI_DROP_PERCENT}% | 数据点: ${oiValues.length} | 触发: ${triggered} | [来源] 06:39 TIA即时分析: "OI见顶回落，关注是否持续下降"`);

      return triggered;
    } catch (error) {
      console.error('[❌TIA OI警报检查错误]', error.message);
      // 不 throw，避免引擎因单个规则崩溃
      return false;
    }
  },

  async collect() {
    try {
      const klines = await api.getOKXKlines(COIN, '1h', LOOKBACK_HOURS, 'SWAP');
      const oiValues = klines
        .filter(k => k.openInterest !== undefined && k.openInterest !== null && k.openInterest > 0)
        .map(k => k.openInterest);

      const peakOI = Math.max(...oiValues);
      const currentOI = oiValues[oiValues.length - 1];

      const ticker = await api.getOKXTicker(COIN, 'SWAP');
      const dropPct = peakOI ? ((peakOI - currentOI) / peakOI * 100) : 0;

      let taker = null, lsr = null;
      try { taker = await api.getOKXTakerRatio(COIN); } catch (e) {}
      try { lsr = await api.getOKXLongShortRatio(COIN); } catch (e) {}

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentOI: currentOI,
        peakOI: peakOI,
        oiDropPercent: dropPct.toFixed(1),
        lookbackHours: LOOKBACK_HOURS,
        takerBuyRatio: taker?.currentRatio,
        longShortRatio: lsr?.currentRatio,
        alertType: 'TIA持仓量下降',
        significance: `TIA OI从峰值${peakOI?.toFixed(0)}降至${currentOI?.toFixed(0)}（${LOOKBACK_HOURS}h滚动窗口），降幅${dropPct.toFixed(1)}%，超过${OI_DROP_PERCENT}%阈值，趋势可能失去动能`
      };
    } catch (error) {
      console.error('[❌TIA OI数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${alertData.coin}-oi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据(TIA OI下降)。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    const model = CONFIG.trigger.altcoin.model;
    spawn('openclaw', [
      'cron', 'add', '--agent', 'july',
      '--model', model,
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run', '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[TIA OI警报触发v2] 已派发即时分析任务: ${jobName} | OI降幅: ${alertData.oiDropPercent}% | 滚动窗口: ${LOOKBACK_HOURS}h`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
