/**
 * ORDI Taker买卖比持续回升警报（升级版）
 * 监控 Taker 买卖比是否持续回升至多头区域（>1.2），
 * 如果连续3个4H时段 > 1.2，可能预示趋势反转
 *
 * ⚠️ 升级说明（2026-05-13 20:50）：
 * 旧版：连续2个1H时段 > 1.2 → 过于敏感，频繁触发假信号
 * 新版：连续3个4H时段 > 1.2 → 更严格的确认，减少假突破
 *
 * 来源: alt-report-ORDI-2026-05-13-2050.md
 * 报告观点: "Taker比回升已被量价背离+清算数据双重证伪——Taker比1.51+价格下跌+OI下降+多头清算$1.08M=空头回补遭遇更强卖压。
 *           维持做空持仓。观察条件：Taker比>1.2连续3个4H+OI转增+价格站回$4.956→减仓/平仓。"
 */

const { spawn } = require('child_process');
const { execSync } = require('child_process');

const COIN = 'ORDI';
const CREATED_DATE = '2026-05-13';
const COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4小时冷却（4H级别检查，冷却相应延长）
const PROXY_URL = 'http://127.0.0.1:7890';

// Taker 买卖比阈值
const TAKER_RATIO_THRESHOLD = 1.2;
// 连续确认时段数（4H级别，3个=12小时）
const CONFIRM_PERIODS = 3;
// 检查的时段数（取最近N个4H时段）
const CHECK_PERIODS = 4;

module.exports = {
  name: 'ORDI-Taker买卖比持续回升(4H)',
  interval: 30 * 60 * 1000, // 30分钟检查一次（4H级别无需太频繁）
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) {
      return false;
    }

    try {
      const url = `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=4H`;
      const result = execSync(
        `curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`,
        { encoding: 'utf8', timeout: 20000 }
      );
      const data = JSON.parse(result);

      if (data.code !== '0' || !data.data || data.data.length < CHECK_PERIODS) {
        console.log(`[🔍警报检查] [API] ${COIN} Taker数据获取失败 | code=${data.code}`);
        return false;
      }

      // 计算最近 CHECK_PERIODS 个4H时段的 Taker 买卖比
      const recentPeriods = data.data.slice(0, CHECK_PERIODS);
      const ratios = recentPeriods.map(d => {
        const buyVol = parseFloat(d[1]);
        const sellVol = parseFloat(d[2]);
        return sellVol > 0 ? buyVol / sellVol : 0;
      });

      // 统计连续 > 阈值的时段数（从最新时段开始）
      let consecutiveCount = 0;
      for (const ratio of ratios) {
        if (ratio >= TAKER_RATIO_THRESHOLD) {
          consecutiveCount++;
        } else {
          break; // 连续中断
        }
      }

      const triggered = consecutiveCount >= CONFIRM_PERIODS;
      const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;

      console.log(`[🔍警报检查] [API] OKX获取${COIN} Taker数据(4H) | [进度] ${this.name} | 最近${CHECK_PERIODS}时段比: [${ratios.map(r => r.toFixed(3)).join(', ')}] | 连续>${TAKER_RATIO_THRESHOLD}: ${consecutiveCount}次 | 阈值: 连续${CONFIRM_PERIODS}次 | 触发: ${triggered}`);

      return triggered;

    } catch (err) {
      console.log(`[🔍警报检查] [API] ${COIN} Taker数据获取异常: ${err.message}`);
      return false;
    }
  },

  async collect() {
    try {
      const url = `https://www.okx.com/api/v5/rubik/stat/taker-volume?instId=${COIN}-USDT-SWAP&instType=CONTRACTS&ccy=${COIN}&period=4H`;
      const result = execSync(
        `curl -s --max-time 15 --proxy "${PROXY_URL}" "${url}"`,
        { encoding: 'utf8', timeout: 20000 }
      );
      const data = JSON.parse(result);

      const recentPeriods = data.data.slice(0, CHECK_PERIODS);
      const ratios = recentPeriods.map(d => {
        const buyVol = parseFloat(d[1]);
        const sellVol = parseFloat(d[2]);
        return sellVol > 0 ? buyVol / sellVol : 0;
      });

      // 获取当前价格
      const tickerUrl = `https://www.okx.com/api/v5/market/ticker?instId=${COIN}-USDT-SWAP`;
      const tickerResult = execSync(
        `curl -s --max-time 10 --proxy "${PROXY_URL}" "${tickerUrl}"`,
        { encoding: 'utf8', timeout: 15000 }
      );
      const tickerData = JSON.parse(tickerResult);
      const currentPrice = tickerData.code === '0' ? parseFloat(tickerData.data[0].last) : 0;

      // 获取 OI 数据（判断是否伴随 OI 增加）
      let oiValue = null;
      try {
        const oiUrl = `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${COIN}&period=4H`;
        const oiResult = execSync(
          `curl -s --max-time 10 --proxy "${PROXY_URL}" "${oiUrl}"`,
          { encoding: 'utf8', timeout: 15000 }
        );
        const oiData = JSON.parse(oiResult);
        if (oiData.code === '0' && oiData.data && oiData.data.length >= 2) {
          const latestOI = parseFloat(oiData.data[0][1]);
          const prevOI = parseFloat(oiData.data[1][1]);
          oiValue = { current: latestOI, previous: prevOI, trend: latestOI > prevOI ? 'increasing' : 'decreasing' };
        }
      } catch (e) { /* 静默 */ }

      const aboveCount = ratios.filter(r => r >= TAKER_RATIO_THRESHOLD).length;

      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: 'Taker买卖比持续回升(4H)',
        currentPrice: currentPrice,
        takerRatios: ratios.map(r => parseFloat(r.toFixed(3))),
        takerThreshold: TAKER_RATIO_THRESHOLD,
        consecutivePeriods: aboveCount,
        oiData: oiValue,
        significance: `Taker买卖比连续${aboveCount}个4H时段超过${TAKER_RATIO_THRESHOLD}，主动买压持续恢复${oiValue?.trend === 'increasing' ? '，且OI增加（新多头入场）' : '，但OI未增加（可能是空头回补）'}，需关注做空仓位风险`
      };
    } catch (err) {
      return {
        coin: COIN,
        alertTime: new Date().toISOString(),
        alertType: 'Taker买卖比持续回升(4H)',
        error: err.message
      };
    }
  },

  async trigger(alertData) {
    const json = JSON.stringify(alertData);
    const now = new Date().toISOString();
    const jobName = `alert-${alertData.coin}-${Date.now()}`;
    const message = `[SPAWN_INSTANT_ANALYSIS]${json}\n\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理\n每个阶段完成后自动进入下一阶段，最终输出全流程摘要。`;

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

    console.log(`[${alertData.coin}警报触发] 已派发即时分析任务: ${jobName} | Taker比4H级别触发 | 连续${alertData.consecutivePeriods}个4H时段>1.2`);
    this.lastTriggered = Date.now();
  },

  lifetime() {
    const ageMs = Date.now() - new Date(CREATED_DATE).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    // 做空仓位存续期间有效，最长7天
    return ageDays < 7 ? 'active' : 'expired';
  }
};
