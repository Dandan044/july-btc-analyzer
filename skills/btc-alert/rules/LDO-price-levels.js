const api = require('../../btc-market-lite/scripts/api');
const { spawn } = require('child_process');

const COIN = 'LDO';
const CREATED_DATE = '2026-05-12';
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Price levels with confirm policies
const LEVELS = [
  { price: 0.405, dir: 'above', desc: '4H 61.8% Fib回撤位/做多入场触发', policy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.4274, dir: 'above', desc: '4H 38.2% Fib/动量延续', policy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.3939, dir: 'below', desc: '日线38.2% Fib支撑', policy: 'hold', confirmMs: 15 * 60 * 1000 },
  { price: 0.3669, dir: 'below', desc: '日线50% Fib/关键支撑破位', policy: 'hold', confirmMs: 15 * 60 * 1000 },
];

module.exports = {
  name: 'LDO-price-levels',
  interval: 3 * 60 * 1000,
  lastTriggered: 0,

  async check() {
    if (Date.now() - this.lastTriggered < COOLDOWN_MS) return false;

    try {
      const klines = await api.getOKXKlines(COIN, '4H', 2);
      if (!klines || klines.length < 1) return false;

      const current = klines[0];
      const high = parseFloat(current.high);
      const low = parseFloat(current.low);

      for (const level of LEVELS) {
        if (level.dir === 'above' && low >= level.price) return true;
        if (level.dir === 'below' && high <= level.price) return true;
      }
      return false;
    } catch (error) {
      console.error('[LDO警报检查错误]', error.message);
      throw error;
    }
  },

  async collect() {
    const ticker = await api.getOKXTicker(COIN);
    const klines4h = await api.getOKXKlines(COIN, '4H', 2);
    const klines1h = await api.getOKXKlines(COIN, '1H', 6);

    const triggered = [];
    const current4h = klines4h[0];
    const high4h = parseFloat(current4h.high);
    const low4h = parseFloat(current4h.low);

    for (const level of LEVELS) {
      const touched = (level.dir === 'above' && low4h >= level.price) ||
                      (level.dir === 'below' && high4h <= level.price);
      if (touched) {
        triggered.push({
          price: level.price,
          direction: level.dir,
          description: level.desc,
          confirmPolicy: level.policy,
          confirmMs: level.confirmMs,
        });
      }
    }

    return {
      coin: COIN,
      currentPrice: ticker.price,
      change24h: ticker.change24h,
      volume24h: ticker.volume24h,
      high4h: high4h,
      low4h: low4h,
      triggeredLevels: triggered,
      allLevels: LEVELS.map(l => ({ price: l.price, dir: l.dir, desc: l.desc })),
    };
  },

  trigger(alert) {
    this.lastTriggered = Date.now();
    const levels = alert.data.triggeredLevels.map(l => `${l.direction === 'above' ? '⬆️' : '⬇️'} $${l.price} (${l.description})`).join(', ');
    console.log(`[LDO价格警报] ${alert.data.currentPrice} | 触发: ${levels}`);

    const child = spawn('node', [
      '-e',
      `const {execSync} = require('child_process');
       const data = ${JSON.stringify(alert.data)};
       const msg = "[SPAWN_INSTANT_ANALYSIS]" + JSON.stringify(data) + "\\n以上为警报触发数据。请按顺序完成即时分析全四阶段：\\n1. 读取 tasks/alt-instant-stage1.md 执行数据获取\\n2. 读取 tasks/alt-intel-stage2.md 执行交叉验证分析\\n3. 读取 tasks/alt-intel-stage3.md 执行仓位管理\\n4. 读取 tasks/alt-intel-stage4.md 执行警报管理";
       execSync("openclaw sessions spawn --agent july --mode run --task " + JSON.stringify(msg), {stdio: 'inherit'});`
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  },

  lifetime() {
    const ageHours = (Date.now() - new Date(CREATED_DATE).getTime()) / (1000 * 60 * 60);
    return ageHours < 72 ? 'active' : 'expired';
  }
};