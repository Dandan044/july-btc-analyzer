/**
 * USELESS 持仓量异动警报（非价格）
 * 监控 OI 快速变化——OI 骤增可能预示新资金入场/逼空加速，OI 骤减可能预示获利了结
 *
 * 来源：active/alt-USELESS-20260507-0804/reports/alt-report-USELESS-2026-05-07-0808.md
 * 报告观点：当前逼空行情中，OI变化是判断趋势持续性的关键指标。
 *           OI持续增长 = 多头加仓逼空继续；OI骤降 = 获利了结信号。
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'USELESS';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const COIN = 'USELESS';
const CREATED_DATE = '2026-05-07';
const COOLDOWN_MS = 60 * 60 * 1000;
const OI_CHANGE_THRESHOLD = 15; // OI 4小时内变化超过15%触发

module.exports = {
  name: 'USELESS持仓量异动',
  interval: 5 * 60 * 1000, // 5分钟检查一次（OI数据频率较低）
  lastTriggered: 0,
  lastOI: null,
  lastOICheckTime: null,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const oiData = await api.getOKXOpenInterest();
      if (!oiData || !oiData.current) {
        console.log('[🔍警报检查] [API] OKX获取BTC持仓量 | [进度] USELESS持仓量异动 | 数据不可用 | 触发: false');
        return false;
      }

      const currentOI = oiData.current;
      const now = Date.now();

      // 首次运行，记录基准
      if (this.lastOI === null) {
        this.lastOI = currentOI;
        this.lastOICheckTime = now;
        console.log(`[🔍警报检查] [API] OKX获取BTC持仓量 | [进度] USELESS持仓量异动 | 初始OI: ${currentOI} | 触发: false | [来源] 05-07 08:08山寨报告: "OI变化是判断逼空趋势持续性的关键指标"`);
        return false;
      }

      // 需要至少间隔1小时才有意义
      const elapsedHours = (now - this.lastOICheckTime) / (60 * 60 * 1000);
      if (elapsedHours < 1) {
        console.log(`[🔍警报检查] [API] OKX获取BTC持仓量 | [进度] USELESS持仓量异动 | OI: ${currentOI} | 距上次检查: ${Math.floor(elapsedHours * 60)}min | 等待满1h | [来源] 05-07 08:08山寨报告: "OI变化是判断逼空趋势持续性的关键指标"`);
        return false;
      }

      const changePct = ((currentOI - this.lastOI) / this.lastOI) * 100;
      const absChangePct = Math.abs(changePct);
      const direction = changePct >= 0 ? '增' : '减';
      const triggered = absChangePct >= OI_CHANGE_THRESHOLD;

      console.log(`[${triggered ? '⚡' : '🔍'}警报检查] [API] OKX获取BTC持仓量 | [进度] USELESS持仓量异动 | 1h OI变化: ${direction}${absChangePct.toFixed(1)}% | 阈值: ±${OI_CHANGE_THRESHOLD}% | 触发: ${triggered} | [来源] 05-07 08:08山寨报告: "OI变化是判断逼空趋势持续性的关键指标"`);

      // 更新基准
      this.lastOI = currentOI;
      this.lastOICheckTime = now;

      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    const ticker = await api.getOKXTicker(COIN, 'SWAP');
    const oiData = await api.getOKXOpenInterest();

    const changePct = this.lastOI ? ((oiData.current - this.lastOI) / this.lastOI * 100) : 0;

    return {
      coin: COIN,
      alertTime: new Date().toISOString(),
      alertType: '持仓量异动',
      currentPrice: ticker.price,
      change24h: ticker.change24h,
      volume24h: ticker.volume24h,
      openInterest: oiData.current,
      oiChangePercent: changePct.toFixed(2),
      oiChangeDirection: changePct >= 0 ? 'increase' : 'decrease',
      positionContext: '做多 50张(减仓40%后)，均价~0.04822，SL=0.0420'
    };
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-oi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [