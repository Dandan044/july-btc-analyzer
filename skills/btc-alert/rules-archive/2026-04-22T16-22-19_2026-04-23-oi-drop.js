/**
 * 持仓量急剧下降警报 - OI跌破$3,500M
 * 触发条件：BTC 持仓量OI从当前$3,642M急剧下降至$3,500M以下
 * 触发后：执行即时分析，评估多头是否正在平仓离场
 * 
 * 依据：04-23 00:15即时分析报告判断"OI从 $3,633M 增至 $3,642M（+$9M），
 *       虽然增量较小但方向仍是增加，说明突破后没有出现多头平仓潮。
 *       若OI下降至 $3,500M以下 → 多头平仓离场，风险加大"。
 *       持仓量是资金动向的领先指标，快速下降往往预示趋势反转。
 * 
 * 数据源：OKX 持仓量 API（需代理）
 */

const { execSync } = require('child_process');
const { spawn } = require('child_process');

const CREATED_DATE = '2026-04-23';
const OI_THRESHOLD = 3.5e9; // $3,500M（持仓量警戒线）
const COOLDOWN_MS = 60 * 60 * 1000; // 1小时冷却

module.exports = {
  name: '持仓量急剧下降警报',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const proxy = 'http://127.0.0.1:7890';
      // 使用1H周期追踪持仓量变化
      const url = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H&limit=1';
      const result = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${url}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const data = JSON.parse(result);
      if (!data.data || !data.data[0]) return false;

      // 数据格式：[timestamp, oi_btc, oi_usdt]
      const row = data.data[0];
      const oiUsdt = parseFloat(row[2]);

      if (isNaN(oiUsdt)) return false;

      const triggered = oiUsdt < OI_THRESHOLD;

      console.log(`[🔍警报检查] [API] OKX获取1H持仓量数据 | [进度] ${this.name} | OI: $${(oiUsdt/1e9).toFixed(3)}B | 阈值: $${(OI_THRESHOLD/1e9).toFixed(1)}B | 触发: ${triggered} | [来源] 04-23 00:15即时分析: "若OI下降至$3,500M以下 → 多头平仓离场，风险加大"`);
      return triggered;
    } catch (error) {
      console.error('[❌警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    try {
      const proxy = 'http://127.0.0.1:7890';
      
      // 获取持仓量历史（1H）
      const oiUrl = 'https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H&limit=12';
      const oiResult = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${oiUrl}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      // 获取多空比辅助分析
      const ratioUrl = 'https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=BTC&period=1H&limit=6';
      const ratioResult = execSync(
        `curl -s --max-time 10 --proxy "${proxy}" "${ratioUrl}"`,
        { encoding: 'utf8', timeout: 15000 }
      );

      const api = require('../../btc-market-lite/scripts/api');
      const ticker = await api.getTicker('BTC');
      const klines = await api.getKlines('BTC', '1h', 6);

      const oiData = JSON.parse(oiResult);
      const ratioData = JSON.parse(ratioResult);

      const oiRows = oiData.data || [];
      const ratioRows = ratioData.data || [];

      const oiHistory = oiRows.map((r, i) => ({
        time: new Date(parseInt(r[0])).toISOString(),
        oiBtc: parseFloat(r[1]),
        oiUsdt: parseFloat(r[2]),
        ratio: ratioRows[i] ? parseFloat(ratioRows[i][1]) : null
      })).reverse();

      const latest = oiHistory[0] || {};
      const prev = oiHistory[1] || {};

      return {
        alertTime: new Date().toISOString(),
        currentPrice: ticker.price,
        priceChange: {
          '1h': ticker.change1h,
          '24h': ticker.change24h
        },
        latestOi: latest.oiUsdt,
        prevOi: prev.oiUsdt,
        oiChange: latest.oiUsdt && prev.oiUsdt ? `${(((latest.oiUsdt - prev.oiUsdt) / prev.oiUsdt) * 100).toFixed(2)}%` : null,
        oiHistory: oiHistory.map(r => ({
          time: r.time,
          oiUsdt: r.oiUsdt ? `$${(r.oiUsdt/1e9).toFixed(3)}B` : null,
          ratio: r.ratio ? r.ratio.toFixed(3) : null
        })),
        threshold: `$${(OI_THRESHOLD/1e9).toFixed(1)}B`,
        alertType: '持仓量变化（非价格）',
        significance: `OI从 ${prev.oiUsdt ? `$${(prev.oiUsdt/1e9).toFixed(3)}B` : '?'} 急剧下降至 ${latest.oiUsdt ? `$${(latest.oiUsdt/1e9).toFixed(3)}B` : '?'}（阈值$3.5B）。多头正在平仓离场，风险加大。若OI持续下降且价格跌破 $79,000 → 确认做空信号。`
      };
    } catch (error) {
      console.error('[❌数据收集错误]', error.message);
      throw error;
    }
  },

  async trigger(data) {
    const now = new Date().toISOString();
    const jobName = `alert-oi-drop-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${JSON.stringify(data)}`;

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

    console.log(`[⚡警报触发] ${this.name} | 已创建即时分析任务: ${jobName}`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const today = new Date().toISOString().split('T')[0];
    return today === CREATED_DATE ? 'active' : 'expired';
  }
};
