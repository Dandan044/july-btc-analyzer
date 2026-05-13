const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'KMNO';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// OI 变化监控 - 报告指出OI从380K降至314K是趋势衰减信号
// 触发条件：OI回升至350K+（新多头入场）或OI降至280K以下（资金加速撤离）
const OI_HIGH_THRESHOLD = 350000;  // OI回升 → 新资金入场
const OI_LOW_THRESHOLD = 280000;   // OI急降 → 资金加速撤离

module.exports = {
  name: 'KMNO-oi-change',
  interval: 5 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      // 使用 OKX Rubik API 获取持仓量（execSync + curl，避免依赖 node-fetch）
      const { execSync } = require('child_process');
      const PROXY = process.env.HTTP_PROXY || 'http://127.0.0.1:7890';
      const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=KMNO&period=1D';
      const result = execSync(`curl -s --max-time 15 --proxy "${PROXY}" "${url}"`, {
        encoding: 'utf8',
        timeout: 20000
      });
      const data = JSON.parse(result);

      if (!data.data || !data.data.length) {
        console.log(`[🔍警报检查] [API] OKX Rubik获取KMNO持仓量 | 数据为空 | 触发: false`);
        return false;
      }

      // 最新OI数据（data格式: [[ts, oi, volume], ...]）
      const latestOI = parseFloat(data.data[0][1]);
      const triggered = latestOI >= OI_HIGH_THRESHOLD || latestOI <= OI_LOW_THRESHOLD;
      const direction = latestOI >= OI_HIGH_THRESHOLD ? '⬆️回升' : '⬇️急降';

      console.log(`[🔍警报检查] [API] OKX Rubik获取KMNO持仓量 | [进度] ${this.name} | 当前OI: ${Math.round(latestOI)} | 上限: ${OI_HIGH_THRESHOLD} | 下限: ${OI_LOW_THRESHOLD} | ${triggered ? direction : '区间内'} | 触发: ${triggered} | [来源] 05-13 KMNO首次分析: "OI从380K降至314K(-17.3%)是趋势衰减信号，OI回升至350K+为做多确认"`);
      
      if (triggered) {
        this._oiData = { latestOI, direction: latestOI >= OI_HIGH_THRESHOLD ? 'above' : 'below' };
      }
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const ticker = await api.getOKXTicker(COIN);
      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        oiAlert: this._oiData || {},
        note: this._oiData?.direction === 'above' ? 'OI回升至350K+，新多头入场信号' : 'OI降至280K以下，资金加速撤离'
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-KMNO-oi-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}
以上为警报触发数据。请按顺序完成即时分析全四阶段：
1. 读取 tasks/alt-instant-stage1.md 执行数据获取
2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析
3. 读取 tasks/alt-intel-stage3.md 执行仓位管理
4. 读取 tasks/alt-intel-stage4.md 执行警报管理
每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

    spawn('openclaw', [
      'cron', 'add',
      '--agent', 'july',
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
  },

  lifetime() {
    if (this.lastTriggered > 0) return 'completed';
    const today = api.getLocalDate();
    const created = new Date(CREATED_DATE);
    const now = new Date(today);
    const daysDiff = Math.floor((now - created) / (1000 * 60 * 60 * 24));
    return daysDiff <= 7 ? 'active' : 'expired';
  }
};
