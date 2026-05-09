/**
 * WLFI 持仓量（OI）监控警报
 * 
 * 监控 WLFI 的持仓量变化：OI 持续增长确认了反弹趋势有效性
 * 若 OI 突然大幅下降（>30%），可能预示着趋势衰竭
 * 
 * 来源: alt-report-WLFI-2026-05-08-1506.md
 * 报告观点: "OI在底部就已开始增长，价格反弹时继续增长确认了上涨趋势"
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-05-08';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const OI_DROP_THRESHOLD = 0.30; // OI下降30%视为异常

module.exports = {
  name: 'WLFI-持仓量异常监控',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,
  
  lastOI: null,  // 上次检查的OI值

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getKlines('WLFI', '1h', 2);
      const klines15m = await api.getKlines('WLFI', '15m', 4);
      const latestPrice = klines[klines.length - 1].close;

      // 尝试获取 OKX OI 数据
      let currentOI = null;
      let lastOIValue = null;
      
      try {
        const oiResp = await api.fetch('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=WLFI&period=1D');
        if (oiResp && oiResp.length > 0) {
          currentOI = parseFloat(oiResp[0].oi);
        }
      } catch (e) {
        // 使用K线成交量作为替代
        currentOI = klines.reduce((sum, k) => sum + (k.volume || 0), 0);
      }

      if (this.lastOI === null) {
        this.lastOI = currentOI;
        return false;
      }

      lastOIValue = this.lastOI;
      this.lastOI = currentOI;

      // 检查 OI 下降幅度
      if (lastOIValue > 0 && currentOI > 0) {
        const drop = 1 - (currentOI / lastOIValue);
        
        if (drop > OI_DROP_THRESHOLD) {
          console.log(`[🔍警报检查] [API] OKX获取WLFI持仓量数据 | [进度] ${this.name} | OI降幅: ${(drop*100).toFixed(1)}% | 阈值: ${OI_DROP_THRESHOLD*100}% | 触发: true | [来源] 05-08 WLFI报告: "OI增长确认趋势，若OI骤降可能预示趋势衰竭"`);
          return true;
        }
        
        console.log(`[🔍警报检查] [API] OKX获取WLFI持仓量数据 | [进度] ${this.name} | 当前OI: ${currentOI.toFixed(2)} | 上次: ${lastOIValue.toFixed(2)} | 变化: ${(drop*100).toFixed(1)}% | 触发: false`);
      } else {
        console.log(`[🔍警报检查] [API] OKX获取WLFI持仓量数据 | [进度] ${this.name} | OI数据获取异常(kline替代: ${currentOI}) | 触发: false`);
      }

      return false;
    } catch (error) {
      console.error('[❌WLFI-OI检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker('WLFI');
      const klines15m = await api.getKlines('WLFI', '15m', 8);

      return {
        coin: 'WLFI',
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        
        triggerType: 'OI异常下降',
        oiAnalysis: {
          lastOI: this.lastOI?.toFixed(2),
          thresholdPercent: OI_DROP_THRESHOLD * 100,
          significance: '持仓量大幅下降可能意味着资金正在离场，趋势可能衰竭'
        },
        
        priceChange: { '1h': ticker.change1h },
        klines15m: klines15m.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume
        })),
        
        alertType: 'OI异常下降'
      };
    } catch (error) {
      console.error('[❌WLFI-OI数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const json = JSON.stringify(data);
    const now = new Date().toISOString();
    const jobName = `alert-WLFI-oi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
      '--model', 'deepseek/deepseek-v4-flash',
      '--session', 'isolated',
      '--at', now,
      '--message', message,
      '--name', jobName,
      '--delete-after-run',
      '--no-deliver'
    ], { detached: true, stdio: 'ignore' });

    console.log(`[WLFI-OI触发] 已派发即时分析任务: ${jobName} | OI降幅超过阈值`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};
