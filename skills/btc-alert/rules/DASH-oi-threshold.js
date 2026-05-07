/**
 * DASH 持仓量阈值监控警报
 * 监控 DASH-USDT-SWAP 持仓量变化，捕捉资本流向信号
 *
 * 来源: active/alt-DASH-20260506-2004/reports/alt-report-DASH-20260507-0434.md
 * 报告观点: "OI从峰值6.35M降至5.46M(23:00)后回升至6.34M(04:00)，
 *           但回升发生在缩量环境中——存量资金换手而非新钱涌入。
 *           若OI再次跌破5.5M=资金系统出走，若突破7.5M新入场"
 *
 * 触发条件:
 *   - OI < 5.5M: 多头资金系统出走，空头加速确认
 *   - OI > 7.5M: 新资金涌入，需重新评估方向
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');
const CONFIG = require('../../../../tasks/global-config.json');
const COIN = 'DASH';  // ← 模型从 global-config.json trigger.{btc|altcoin}.model 读取

const CREATED_DATE = '2026-05-07';
const OI_LOW_THRESHOLD = 5500000;   // 5.5M
const OI_HIGH_THRESHOLD = 7500000;  // 7.5M
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: 'DASH-OI阈值监控',
  interval: 10 * 60 * 1000, // OI变化偏慢，10分钟足够
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      // 使用OKX持仓量API
      const raw = await api.fetch(
        'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=DASH&period=1D',
        { timeout: 15000 }
      );

      if (!raw || raw.code !== '0' || !raw.data || raw.data.length === 0) {
        console.log('[🔍DASH-OI检查] [API] OKX OI接口返回数据为空');
        return false;
      }

      // 最新一个数据点
      const latest = raw.data[raw.data.length - 1];
      const oi = parseFloat(latest.oi || 0);
      const oiValue = parseFloat(latest.oiValue || 0);

      const triggered = oi > 0 && (oi < OI_LOW_THRESHOLD || oi > OI_HIGH_THRESHOLD);

      console.log(`[🔍DASH-OI检查] [API] OKX Open Interest | [进度] ${this.name} | OI: ${oi.toFixed(2)}张($${(oiValue / 1000000).toFixed(2)}M) | 低位阈值: ${OI_LOW_THRESHOLD} | 高位阈值: ${OI_HIGH_THRESHOLD} | 触发: ${triggered} | [来源] DASH 05-07 04:34即时分析: OI震荡回6.34M`);

      return triggered;
    } catch (error) {
      console.error('[❌DASH-OI检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const raw = await api.fetch(
        'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=DASH&period=1D',
        { timeout: 15000 }
      );

      let oi = 0, oiValue = 0;
      if (raw && raw.code === '0' && raw.data && raw.data.length > 0) {
        const latest = raw.data[raw.data.length - 1];
        oi = parseFloat(latest.oi || 0);
        oiValue = parseFloat(latest.oiValue || 0);
      }

      const triggeredType = oi < OI_LOW_THRESHOLD ? 'OI跌破低位阈值' :
                            oi > OI_HIGH_THRESHOLD ? 'OI突破高位阈值' : '无';

      return {
        coin: 'DASH',
        alertTime: new Date().toISOString(),
        oiCurrent: oi,
        oiCurrentFormatted: `${(oi / 1000000).toFixed(2)}M张`,
        oiValueCurrent: oiValue,
        oiValueFormatted: `$${(oiValue / 1000000).toFixed(2)}M`,
        oiLowThreshold: OI_LOW_THRESHOLD,
        oiLowThresholdFormatted: `5.5M张`,
        oiHighThreshold: OI_HIGH_THRESHOLD,
        oiHighThresholdFormatted: `7.5M张`,
        triggeredType: triggeredType,
        alertType: '持仓量异动',
        significance: triggeredType === 'OI跌破低位阈值'
          ? `DASH持仓量已降至${(oi / 1000000).toFixed(2)}M(阈值5.5M)，多头资金持续出逃，空头加速确认`
          : `DASH持仓量已升至${(oi / 1000000).toFixed(2)}M(阈值7.5M)，新资金涌入，需重新评估方向`
      };
    } catch (error) {
      console.error('[❌DASH-OI数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${alertData.coin || 'alt'}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;


    // 根据币种选择模型：BTC → trigger.btc.model (pro)，山寨币 → trigger.altcoin.model (flash)
    const model = CONFIG.trigger[COIN === 'BTC' ? 'btc' : 'altcoin'].model;
    spawn('openclaw', [