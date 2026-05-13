/**
 * USELESS 资金费率监控警报
 * 
 * 监控 USELESS 合约资金费率降至 0 或负值
 * 当多头过度清算后，资金费率转负意味着空头付费，为反弹创造条件
 * 
 * 来源：alt-USELESS-20260513-1305/reports/alt-report-USELESS-2026-05-13-1310.md
 * 报告观点：做多条件之一为资金费率降至0或负值
 */

const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'USELESS';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却
const FUNDING_THRESHOLD = 0; // 触发阈值：资金费率 ≤ 0

module.exports = {
  name: 'USELESS-资金费率监控',
  interval: 5 * 60 * 1000, // 5分钟检查
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;
    
    try {
      // 获取资金费率（通过 klines4h 中的 fundingRate 数据）
      const PROXY_URL = 'http://127.0.0.1:7890';
      const { execSync } = require('child_process');
      const result = execSync(
        `curl -s --max-time 10 --proxy "${PROXY_URL}" "https://www.okx.com/api/v5/public/funding-rate?instId=${COIN}-USDT-SWAP"`,
        { encoding: 'utf8', timeout: 15000 }
      );
      const data = JSON.parse(result);
      const fundingRate = parseFloat(data.data[0].fundingRate);
      
      const triggered = fundingRate <= FUNDING_THRESHOLD;
      console.log(`[🔍警报检查] [API] OKX获取${COIN}资金费率 | [进度] ${this.name} | 当前费率: ${fundingRate.toFixed(6)} | 阈值: ≤${FUNDING_THRESHOLD} | 触发: ${triggered} | [依据] alt-report-USELESS-2026-05-13-1310: 资金费率降至0或负值为做多条件之一`);
      
      this._lastFundingRate = fundingRate;
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getTicker(COIN);
      const klines = await api.getKlines(COIN, '4h', 6);
      
      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        fundingRate: this._lastFundingRate,
        fundingThreshold: FUNDING_THRESHOLD,
        priceChange: { '1h': ticker.change1h, '24h': ticker.change24h },
        klines4h: klines.map(k => ({
          time: k.datetime, open: k.open, high: k.high, low: k.low, close: k.close
        })),
        alertType: '资金费率转负',
        significance: '资金费率降至0或负值，空头开始付费给多头，多头过度清算后可能形成反弹条件'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-${COIN}-funding-${Date.now()}`;
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

    console.log(`[${COIN}警报触发] 资金费率转负，已派发即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 5 ? 'active' : 'expired';
  }
};
