/**
 * GALA 持仓量异动监控规则
 * 
 * 监测 OI 显著萎缩（趋势衰竭信号）或快速增加（新资金涌入）
 * 
 * 来源: alt-report-GALA-2026-05-08-2308.md
 * 核心结论: 「OI同步上升意味着新资金进入，如果OI大幅萎缩则多头退场」
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../tasks/global-config.json');

const COIN = 'GALA';
const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

// OI 萎缩幅度阈值（与24h前相比）
const OI_SHRINK_THRESHOLD = -0.30; // OI 萎缩 30% 触发
// OI 暴增阈值
const OI_SURGE_THRESHOLD = 0.50;   // OI 暴增 50% 触发

// 存储上次 OI 值用于计算变化
let prevOI = 0;

module.exports = {
  name: 'GALA-OI监控',
  interval: 3 * 60 * 1000, // 3分钟
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const ticker = await api.getTicker(COIN);
      const oi = ticker.openInterest || 0;
      const currentPrice = ticker.price;

      // 首次采样，记录基准值
      if (prevOI === 0) {
        prevOI = oi;
        console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量 | [进度] ${this.name} | OI: ${oi.toFixed(0)} GALA | 基准值: ${prevOI.toFixed(0)} GALA | 触发: false | [来源] alt-report-GALA-2026-05-08: "OI变化指示新资金流向"`);
        return false;
      }

      const oiChange = (oi - prevOI) / prevOI;
      prevOI = oi; // 更新基准值（滚动式）

      // OI 大幅萎缩 → 多头撤退信号
      if (oiChange <= OI_SHRINK_THRESHOLD) {
        this._triggerType = 'oi_shrink';
        this._oiChange = oiChange;
        this._currentOI = oi;

        console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量 | [进度] ${this.name} | OI: ${oi.toFixed(0)} | 变化: ${(oiChange*100).toFixed(1)}% | 阈值: -30% | 触发: true | [来源] alt-report-GALA-2026-05-08: "OI大幅萎缩说明多头退场，趋势可能衰竭"`);
        return true;
      }

      // OI 暴增 → 资金大量涌入
      if (oiChange >= OI_SURGE_THRESHOLD) {
        this._triggerType = 'oi_surge';
        this._oiChange = oiChange;
        this._currentOI = oi;

        console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量 | [进度] ${this.name} | OI: ${oi.toFixed(0)} | 变化: ${(oiChange*100).toFixed(1)}% | 阈值: +50% | 触发: true | [来源] alt-report-GALA-2026-05-08: "OI暴增说明新资金大量涌入"`);
        return true;
      }

      // 正常状态
      console.log(`[🔍警报检查] [API] OKX获取${COIN}持仓量 | [进度] ${this.name} | OI: ${oi.toFixed(0)} GALA | 变化: ${(oiChange*100).toFixed(1)}% | 安全 | 触发: false | [来源] alt-report-GALA-2026-05-08`);
      return false;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker(COIN);
      const klines = await api.getKlines(COIN, '15m', 5);

      return {
        coin: COIN,
        alertName: this.name,
        alertType: 'oi',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        currentOI: this._currentOI || ticker.openInterest,
        oiChange: this._oiChange || 0,
        triggerType: this._triggerType || '',
        priceChange1h: ticker.change1h,
        priceChange24h: ticker.change24h,
        volume24h: ticker.volume24h,
        klines15m: klines
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}

以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行技术分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;
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
    ], {
      detached: true,
      stdio: 'ignore'
    });

    this.lastTriggered = Date.now();
    this._triggerType = '';
    this._oiChange = 0;
    this._currentOI = 0;
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 3 ? 'active' : 'expired';
  }
};
